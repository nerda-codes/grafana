package accesscontrol

import (
	"context"
	"errors"
	"fmt"
	"strings"

	zclient "github.com/grafana/zanzana/pkg/service/client"
	openfgav1 "github.com/openfga/api/proto/openfga/v1"

	"github.com/grafana/grafana/pkg/infra/log"
)

var logger = log.New("accesscontrol.evaluator")

type Evaluator interface {
	// Evaluate permissions that are grouped by action
	Evaluate(permissions map[string][]string) bool
	EvaluateZanzana(ctx context.Context, subject, containerID string, c *zclient.GRPCClient) (bool, error)
	// MutateScopes executes a sequence of ScopeModifier functions on all embedded scopes of an evaluator and returns a new Evaluator
	MutateScopes(ctx context.Context, mutate ScopeAttributeMutator) (Evaluator, error)
	// String returns a string representation of permission required by the evaluator

	fmt.Stringer
	fmt.GoStringer
}

var _ Evaluator = new(permissionEvaluator)

// EvalPermission returns an evaluator that will require at least one of passed scopes to match
func EvalPermission(action string, scopes ...string) Evaluator {
	return permissionEvaluator{Action: action, Scopes: scopes}
}

type permissionEvaluator struct {
	Action string
	Scopes []string
}

func (p permissionEvaluator) Evaluate(permissions map[string][]string) bool {
	userScopes, ok := permissions[p.Action]
	if !ok {
		return false
	}

	if len(p.Scopes) == 0 {
		return true
	}

	for _, target := range p.Scopes {
		for _, scope := range userScopes {
			if match(scope, target) {
				return true
			}
		}
	}

	return false
}

func match(scope, target string) bool {
	if scope == "" {
		return false
	}

	if !ValidateScope(scope) {
		logger.Error(
			"invalid scope",
			"scope", scope,
			"reason", "scopes should not contain meta-characters like * or ?, except in the last position",
		)
		return false
	}

	prefix, last := scope[:len(scope)-1], scope[len(scope)-1]
	//Prefix match
	if last == '*' {
		if strings.HasPrefix(target, prefix) {
			logger.Debug("Matched scope", "user scope", scope, "target scope", target)
			return true
		}
	}

	return scope == target
}

// EvaluateZanzana implements Evaluator.
func (p permissionEvaluator) EvaluateZanzana(ctx context.Context, subject, containerID string, c *zclient.GRPCClient) (bool, error) {
	// TODO: fix so this works properly.
	// Right now we can get checks for action that don't have scopes
	// or checks to just know if subject can perform action on any resource.
	// Maybe this can be solved with a read request?
	if len(p.Scopes) == 0 {
		return check(ctx, p.Action, "", subject, containerID, c)
	}

	for _, target := range p.Scopes {
		ok, err := check(ctx, p.Action, target, subject, containerID, c)
		if err != nil {
			return false, err
		}

		if ok {
			return true, nil
		}
	}

	return false, nil
}

func check(ctx context.Context, action, scope, subject, containerID string, c *zclient.GRPCClient) (bool, error) {
	// TODO: move this translation to constructor
	relation, object := zclient.ConvertToRelationObject(action, scope, containerID, zclient.OrgContainer)
	res, err := c.Check(ctx, &openfgav1.CheckRequest{
		StoreId: c.MustStoreID(ctx),
		TupleKey: &openfgav1.CheckRequestTupleKey{
			User:     subject,
			Relation: relation,
			Object:   object,
		},
		AuthorizationModelId: c.AuthorizationModelID,
	})

	if err != nil {
		return false, err
	}

	return res.Allowed, nil
}

func (p permissionEvaluator) MutateScopes(ctx context.Context, mutate ScopeAttributeMutator) (Evaluator, error) {
	if p.Scopes == nil {
		return EvalPermission(p.Action), nil
	}

	resolved := false
	scopes := make([]string, 0, len(p.Scopes))
	for _, scope := range p.Scopes {
		mutated, err := mutate(ctx, scope)
		if err != nil {
			if errors.Is(err, ErrResolverNotFound) {
				scopes = append(scopes, mutated...)
				continue
			}
			return nil, err
		}
		resolved = true
		scopes = append(scopes, mutated...)
	}

	if !resolved {
		return nil, ErrResolverNotFound
	}

	return EvalPermission(p.Action, scopes...), nil
}

func (p permissionEvaluator) String() string {
	return p.Action
}

func (p permissionEvaluator) GoString() string {
	return fmt.Sprintf("action:%s scopes:%s", p.Action, strings.Join(p.Scopes, ", "))
}

var _ Evaluator = new(allEvaluator)

// EvalAll returns evaluator that requires all passed evaluators to evaluate to true
func EvalAll(allOf ...Evaluator) Evaluator {
	return allEvaluator{allOf: allOf}
}

type allEvaluator struct {
	allOf []Evaluator
}

func (a allEvaluator) Evaluate(permissions map[string][]string) bool {
	for _, e := range a.allOf {
		if !e.Evaluate(permissions) {
			return false
		}
	}
	return true
}

// EvaluateZanzana implements Evaluator.
func (a allEvaluator) EvaluateZanzana(ctx context.Context, subject, containerID string, c *zclient.GRPCClient) (bool, error) {
	for _, e := range a.allOf {
		ok, err := e.EvaluateZanzana(ctx, subject, containerID, c)
		if !ok || err != nil {
			return ok, err
		}
	}
	return true, nil
}

func (a allEvaluator) MutateScopes(ctx context.Context, mutate ScopeAttributeMutator) (Evaluator, error) {
	resolved := false
	modified := make([]Evaluator, 0, len(a.allOf))
	for _, e := range a.allOf {
		i, err := e.MutateScopes(ctx, mutate)
		if err != nil {
			if errors.Is(err, ErrResolverNotFound) {
				modified = append(modified, e)
				continue
			}
			return nil, err
		}
		resolved = true
		modified = append(modified, i)
	}

	if !resolved {
		return nil, ErrResolverNotFound
	}
	return EvalAll(modified...), nil
}

func (a allEvaluator) String() string {
	permissions := make([]string, 0, len(a.allOf))
	for _, e := range a.allOf {
		permissions = append(permissions, e.String())
	}

	return fmt.Sprintf("all of %s", strings.Join(permissions, ", "))
}

func (a allEvaluator) GoString() string {
	permissions := make([]string, 0, len(a.allOf))
	for _, e := range a.allOf {
		permissions = append(permissions, e.GoString())
	}

	return fmt.Sprintf("all(%s)", strings.Join(permissions, " "))
}

var _ Evaluator = new(anyEvaluator)

// EvalAny returns evaluator that requires at least one of passed evaluators to evaluate to true
func EvalAny(anyOf ...Evaluator) Evaluator {
	return anyEvaluator{anyOf: anyOf}
}

type anyEvaluator struct {
	anyOf []Evaluator
}

func (a anyEvaluator) Evaluate(permissions map[string][]string) bool {
	for _, e := range a.anyOf {
		if e.Evaluate(permissions) {
			return true
		}
	}
	return false
}

// EvaluateZanzana implements Evaluator.
func (a anyEvaluator) EvaluateZanzana(ctx context.Context, subject, containerID string, c *zclient.GRPCClient) (bool, error) {
	for _, e := range a.anyOf {
		ok, err := e.EvaluateZanzana(ctx, subject, containerID, c)
		if ok || err != nil {
			return ok, err
		}
	}
	return false, nil
}

func (a anyEvaluator) MutateScopes(ctx context.Context, mutate ScopeAttributeMutator) (Evaluator, error) {
	resolved := false
	modified := make([]Evaluator, 0, len(a.anyOf))
	for _, e := range a.anyOf {
		i, err := e.MutateScopes(ctx, mutate)
		if err != nil {
			if errors.Is(err, ErrResolverNotFound) {
				modified = append(modified, e)
				continue
			}
			return nil, err
		}
		resolved = true
		modified = append(modified, i)
	}

	if !resolved {
		return nil, ErrResolverNotFound
	}

	return EvalAny(modified...), nil
}

func (a anyEvaluator) String() string {
	permissions := make([]string, 0, len(a.anyOf))
	for _, e := range a.anyOf {
		permissions = append(permissions, e.String())
	}

	return fmt.Sprintf("any of %s", strings.Join(permissions, ", "))
}

func (a anyEvaluator) GoString() string {
	permissions := make([]string, 0, len(a.anyOf))
	for _, e := range a.anyOf {
		permissions = append(permissions, e.String())
	}

	return fmt.Sprintf("any(%s)", strings.Join(permissions, " "))
}
