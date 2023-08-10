import { css } from '@emotion/css';
import React from 'react';

import { GrafanaTheme2 } from '@grafana/data';
import {
  SceneObject,
  VariableValueSelectors,
  SceneTimePicker,
  SceneRefreshPicker,
  EmbeddedScene,
  SceneFlexLayout,
  SceneTimeRange,
  SceneFlexItem,
  VizPanel,
  SceneObjectState,
  SceneObjectBase,
  SceneVariableSet,
} from '@grafana/scenes';
import { useStyles2 } from '@grafana/ui';
import {
  createPanelDataProvider,
  createSceneVariableFromVariableModel,
} from 'app/features/scenes/dashboard/DashboardsLoader';
import { getVizPanelKeyForPanelId } from 'app/features/scenes/dashboard/utils';

import { getDashboardSrv } from '../../services/DashboardSrv';
import { DashboardModel, PanelModel } from '../../state';

interface PanelSuggestionsProps {
  suggestions: PanelModel[];
  onDismiss: () => void;
}

export const PanelSuggestions = ({ suggestions, onDismiss }: PanelSuggestionsProps) => {
  const styles = useStyles2(getStyles);

  const dashboard = getDashboardSrv().getCurrent() as DashboardModel;

  const onUseSuggestion = (panel: PanelModel) => {
    dashboard?.addPanel(panel);
    onDismiss();
  };

  const previewScene = getSceneModel({ panels: suggestions, dashboard, onClickPanel: onUseSuggestion });

  return (
    <div className={styles.wrapper}>
      <previewScene.Component model={previewScene} />
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css`
    display: flex;
    flex-direction: column;
    margin-top: ${theme.spacing(2)};
    gap: ${theme.spacing(3)};
    margin-bottom: ${theme.spacing(3)};
  `,
  suggestion: css`
    cursor: pointer;
  `,
  suggestionContent: css`
    padding: ${theme.spacing(2)};
  `,
});

function getSceneModel({
  panels,
  dashboard,
  onClickPanel,
}: {
  panels: PanelModel[];
  dashboard: DashboardModel;
  onClickPanel: (panel: PanelModel) => void;
}) {
  const controls: SceneObject[] = [new VariableValueSelectors({}), new SceneTimePicker({}), new SceneRefreshPicker({})];
  const compatibleVariableTypes = (panel: PanelModel) => ['query', 'custom', 'constant', 'custom'].includes(panel.type);
  const compatiblePanelTypes = (panel: PanelModel) => panel.type !== 'row';

  return new EmbeddedScene({
    body: new SceneFlexLayout({
      direction: 'column',

      children: panels
        .filter(compatiblePanelTypes)
        .slice(0, 3)
        .map((panel) => createVizPanelFromPanelModel(panel, onClickPanel)),
    }),
    $timeRange: new SceneTimeRange(),
    // Create dashboards variable set from dashboard model in case suggestions uses the same variables
    $variables: new SceneVariableSet({
      variables: dashboard.templating.list.filter(compatibleVariableTypes).map(createSceneVariableFromVariableModel),
    }),
    controls: controls,
  });
}

// TODO: Figure out why panels sometimes don't render (i.e. "node server")
// TODO: Figure out how to auto migrate from old panel types to new panel types (angular)
// TODO: Bonus - figure out way to filter out panels that are relying on missing DS variable?
export function createVizPanelFromPanelModel(panel: PanelModel, onClick: (panel: PanelModel) => void) {
  // Create Pamel Model from Panel to auto migrate old versions
  const autoMigratedPanel = new PanelModel(panel);
  return new SceneFlexItem({
    minHeight: 200,
    body: new SceneClickableElement({
      onClick: () => onClick(autoMigratedPanel),
      children: new VizPanel({
        key: getVizPanelKeyForPanelId(autoMigratedPanel.id),
        title: autoMigratedPanel.title,
        pluginId: autoMigratedPanel.type,
        options: autoMigratedPanel.options ?? {},
        fieldConfig: autoMigratedPanel.fieldConfig,
        pluginVersion: autoMigratedPanel.pluginVersion,
        displayMode: autoMigratedPanel.transparent ? 'transparent' : undefined,
        // To be replaced with it's own option persisted option instead derived
        hoverHeader: !autoMigratedPanel.title && !autoMigratedPanel.timeFrom && !autoMigratedPanel.timeShift,
        $data: createPanelDataProvider(autoMigratedPanel),
      }),
    }),
  });
}

interface ClickableElementState extends SceneObjectState {
  onClick: () => void;
  children: SceneObject;
}

export class SceneClickableElement extends SceneObjectBase<ClickableElementState> {
  static Component = ClickableElementRenderer;
}

function ClickableElementRenderer({ model }: { model: SceneClickableElement }) {
  const { onClick, children } = model.useState();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          onClick();
        }
      }}
    >
      <children.Component model={children} />
    </div>
  );
}
