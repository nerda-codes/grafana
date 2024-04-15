package cloudmigrationimpl

import (
	"context"

	"github.com/grafana/grafana/pkg/api/routing"
	"github.com/grafana/grafana/pkg/infra/db"
	"github.com/grafana/grafana/pkg/infra/log"
	"github.com/grafana/grafana/pkg/services/cloudmigration"
	"github.com/grafana/grafana/pkg/services/cloudmigration/api"
	"github.com/grafana/grafana/pkg/services/datasources"
	"github.com/grafana/grafana/pkg/services/featuremgmt"
	"github.com/grafana/grafana/pkg/setting"
	"github.com/prometheus/client_golang/prometheus"
)

// CloudMigrationsServiceImpl Define the Service Implementation.
type Service struct {
	store store

	log log.Logger
	cfg *setting.Cfg

	features  featuremgmt.FeatureToggles
	dsService datasources.DataSourceService

	api *api.CloudMigrationAPI
	// metrics *Metrics
}

var LogPrefix = "cloudmigration.service"

var _ cloudmigration.Service = (*Service)(nil)

// ProvideService Factory for method used by wire to inject dependencies.
// builds the service, and api, and configures routes
func ProvideService(
	cfg *setting.Cfg,
	features featuremgmt.FeatureToggles,
	db db.DB,
	dsService datasources.DataSourceService,
	routeRegister routing.RouteRegister,
	prom prometheus.Registerer,
) cloudmigration.Service {
	if !features.IsEnabledGlobally(featuremgmt.FlagOnPremToCloudMigrations) {
		return &NoopServiceImpl{}
	}

	s := &Service{
		store:     &sqlStore{db: db},
		log:       log.New(LogPrefix),
		cfg:       cfg,
		features:  features,
		dsService: dsService,
	}
	s.api = api.RegisterApi(routeRegister, s)

	if err := s.registerMetrics(prom); err != nil {
		s.log.Warn("error registering prom metrics", "error", err.Error())
	}

	return s
}

func (s *Service) CreateToken(ctx context.Context) error {
	// TODO: Implement method
	return nil
}

func (s *Service) ValidateToken(ctx context.Context, token string) error {
	// TODO: Implement method
	return nil
}

func (s *Service) SaveEncryptedToken(ctx context.Context, token string) error {
	// TODO: Implement method
	return nil
}

func (s *Service) GetMigration(ctx context.Context, id int64) (*cloudmigration.CloudMigrationResponse, error) {
	// TODO: Implement method
	return nil, nil
}

func (s *Service) GetMigrationList(ctx context.Context) ([]cloudmigration.CloudMigrationResponse, error) {
	// TODO: Implement method
	return nil, nil
}

func (s *Service) CreateMigration(ctx context.Context, cm cloudmigration.CloudMigrationRequest) (*cloudmigration.CloudMigrationResponse, error) {
	// TODO: Implement method
	return nil, nil
}

func (s *Service) UpdateMigration(ctx context.Context, id int64, cm cloudmigration.CloudMigrationRequest) (*cloudmigration.CloudMigrationResponse, error) {
	// TODO: Implement method
	return nil, nil
}

func (s *Service) RunMigration(ctx context.Context, uid string) (*cloudmigration.CloudMigrationRun, error) {
	// TODO: Implement method
	return nil, nil
}

func (s *Service) GetMigrationStatus(ctx context.Context, id string, runID string) (*cloudmigration.CloudMigrationRun, error) {
	// TODO: Implement method
	return nil, nil
}

func (s *Service) GetMigrationStatusList(ctx context.Context, id string) ([]cloudmigration.CloudMigrationRun, error) {
	// TODO: Implement method
	return nil, nil
}

func (s *Service) DeleteMigration(ctx context.Context, id string) error {
	// TODO: Implement method
	return nil
}

// func (s *Service) MigrateDatasources(ctx context.Context, request *cloudmigration.MigrateDatasourcesRequest) (*cloudmigration.MigrateDatasourcesResponse, error) {
// 	return s.store.MigrateDatasources(ctx, request)
// }
