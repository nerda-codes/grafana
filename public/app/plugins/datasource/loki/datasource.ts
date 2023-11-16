import { cloneDeep, map as lodashMap } from 'lodash';
import { lastValueFrom, merge, Observable, of, throwError } from 'rxjs';
import { catchError, map, switchMap, tap } from 'rxjs/operators';

import {
  AbstractQuery,
  AnnotationEvent,
  AnnotationQueryRequest,
  CoreApp,
  DataFrame,
  DataFrameView,
  DataQueryRequest,
  DataQueryResponse,
  DataSourceInstanceSettings,
  DataSourceWithLogsContextSupport,
  DataSourceWithSupplementaryQueriesSupport,
  SupplementaryQueryType,
  DataSourceWithQueryExportSupport,
  DataSourceWithQueryImportSupport,
  FieldCache,
  FieldType,
  Labels,
  LoadingState,
  LogLevel,
  LogRowModel,
  QueryFixAction,
  QueryHint,
  rangeUtil,
  ScopedVars,
  SupplementaryQueryOptions,
  TimeRange,
  LogRowContextOptions,
  DataSourceWithToggleableQueryFiltersSupport,
  ToggleFilterAction,
  QueryFilterOptions,
  renderLegendFormat,
  LegacyMetricFindQueryOptions,
  DataSourceWithQueryModificationSupportSupport,
} from '@grafana/data';
import { intervalToMs } from '@grafana/data/src/datetime/rangeutil';
import { Duration } from '@grafana/lezer-logql';
import { BackendSrvRequest, config, DataSourceWithBackend } from '@grafana/runtime';
import { DataQuery } from '@grafana/schema';
import { convertToWebSocketUrl } from 'app/core/utils/explore';
import { getTimeSrv, TimeSrv } from 'app/features/dashboard/services/TimeSrv';
import { getTemplateSrv, TemplateSrv } from 'app/features/templating/template_srv';

import { serializeParams } from '../../../core/utils/fetch';
import { queryLogsSample, queryLogsVolume } from '../../../features/logs/logsModel';
import { getLogLevelFromKey } from '../../../features/logs/utils';
import { replaceVariables, returnVariables } from '../prometheus/querybuilder/shared/parsingUtils';

import LanguageProvider from './LanguageProvider';
import { LiveStreams, LokiLiveTarget } from './LiveStreams';
import { LogContextProvider } from './LogContextProvider';
import { transformBackendResult } from './backendResultTransformer';
import { LokiAnnotationsQueryEditor } from './components/AnnotationsQueryEditor';
import { placeHolderScopedVars } from './components/monaco-query-field/monaco-completion-provider/validation';
import { escapeLabelValueInSelector, isRegexSelector } from './languageUtils';
import { labelNamesRegex, labelValuesRegex } from './migrations/variableQueryMigrations';
import {
  addLabelFormatToQuery,
  addLabelToQuery,
  addNoPipelineErrorToQuery,
  addParserToQuery,
  removeCommentsFromQuery,
  addFilterAsLabelFilter,
  getParserPositions,
  toLabelFilter,
  addLineFilter,
  findLastPosition,
  getLabelFilterPositions,
  queryHasFilter,
  removeLabelFromQuery,
} from './modifyQuery';
import { getQueryHints } from './queryHints';
import { runSplitQuery } from './querySplitting';
import {
  getLogQueryFromMetricsQuery,
  getLokiQueryFromDataQuery,
  getNodesFromQuery,
  getNormalizedLokiQuery,
  getStreamSelectorsFromQuery,
  isLogsQuery,
  isQueryWithError,
  requestSupportsSplitting,
} from './queryUtils';
import { doLokiChannelStream } from './streaming';
import { trackQuery } from './tracking';
import {
  LokiOptions,
  LokiQuery,
  LokiQueryType,
  LokiVariableQuery,
  LokiVariableQueryType,
  QueryStats,
  SupportingQueryType,
} from './types';
import { LokiVariableSupport } from './variables';

export type RangeQueryOptions = DataQueryRequest<LokiQuery> | AnnotationQueryRequest<LokiQuery>;
export const DEFAULT_MAX_LINES = 1000;
export const DEFAULT_MAX_LINES_SAMPLE = 10;
export const LOKI_ENDPOINT = '/loki/api/v1';
export const REF_ID_DATA_SAMPLES = 'loki-data-samples';
export const REF_ID_STARTER_ANNOTATION = 'annotation-';
export const REF_ID_STARTER_LOG_ROW_CONTEXT = 'log-row-context-query-';
export const REF_ID_STARTER_LOG_VOLUME = 'log-volume-';
export const REF_ID_STARTER_LOG_SAMPLE = 'log-sample-';
const NS_IN_MS = 1000000;

export function makeRequest(
  query: LokiQuery,
  range: TimeRange,
  app: CoreApp,
  requestId: string,
  hideFromInspector?: boolean
): DataQueryRequest<LokiQuery> {
  const intervalInfo = rangeUtil.calculateInterval(range, 1);
  return {
    targets: [query],
    requestId,
    interval: intervalInfo.interval,
    intervalMs: intervalInfo.intervalMs,
    range: range,
    scopedVars: {},
    timezone: 'UTC',
    app,
    startTime: Date.now(),
    hideFromInspector,
  };
}

export class LokiDatasource
  extends DataSourceWithBackend<LokiQuery, LokiOptions>
  implements
    DataSourceWithLogsContextSupport,
    DataSourceWithSupplementaryQueriesSupport<LokiQuery>,
    DataSourceWithQueryImportSupport<LokiQuery>,
    DataSourceWithQueryExportSupport<LokiQuery>,
    DataSourceWithToggleableQueryFiltersSupport<LokiQuery>,
    DataSourceWithQueryModificationSupportSupport<LokiQuery>
{
  private streams = new LiveStreams();
  private logContextProvider: LogContextProvider;
  languageProvider: LanguageProvider;
  maxLines: number;
  predefinedOperations: string;

  constructor(
    private instanceSettings: DataSourceInstanceSettings<LokiOptions>,
    private readonly templateSrv: TemplateSrv = getTemplateSrv(),
    private readonly timeSrv: TimeSrv = getTimeSrv()
  ) {
    super(instanceSettings);

    this.languageProvider = new LanguageProvider(this);
    const settingsData = instanceSettings.jsonData || {};
    this.maxLines = parseInt(settingsData.maxLines ?? '0', 10) || DEFAULT_MAX_LINES;
    this.predefinedOperations = settingsData.predefinedOperations ?? '';
    this.annotations = {
      QueryEditor: LokiAnnotationsQueryEditor,
    };
    this.variables = new LokiVariableSupport(this);
    this.logContextProvider = new LogContextProvider(this);
  }

  /**
   * Implemented for DataSourceWithSupplementaryQueriesSupport.
   * It retrieves a data provider for a specific supplementary query type.
   * @returns An Observable of DataQueryResponse or undefined if the specified query type is not supported.
   */
  getDataProvider(
    type: SupplementaryQueryType,
    request: DataQueryRequest<LokiQuery>
  ): Observable<DataQueryResponse> | undefined {
    if (!this.getSupportedSupplementaryQueryTypes().includes(type)) {
      return undefined;
    }
    switch (type) {
      case SupplementaryQueryType.LogsVolume:
        return this.getLogsVolumeDataProvider(request);
      case SupplementaryQueryType.LogsSample:
        return this.getLogsSampleDataProvider(request);
      default:
        return undefined;
    }
  }

  /**
   * Implemented for DataSourceWithSupplementaryQueriesSupport.
   * It returns the supplementary types that the data source supports.
   * @returns An array of supported supplementary query types.
   */
  getSupportedSupplementaryQueryTypes(): SupplementaryQueryType[] {
    return [SupplementaryQueryType.LogsVolume, SupplementaryQueryType.LogsSample];
  }

  /**
   * Implemented for DataSourceWithSupplementaryQueriesSupport.
   * It retrieves supplementary queries based on the provided options and Loki query.
   * @returns A supplemented Loki query or undefined if unsupported.
   */
  getSupplementaryQuery(options: SupplementaryQueryOptions, query: LokiQuery): LokiQuery | undefined {
    if (!this.getSupportedSupplementaryQueryTypes().includes(options.type)) {
      return undefined;
    }

    const normalizedQuery = getNormalizedLokiQuery(query);
    const expr = removeCommentsFromQuery(normalizedQuery.expr);
    let isQuerySuitable = false;

    switch (options.type) {
      case SupplementaryQueryType.LogsVolume:
        // it has to be a logs-producing range-query
        isQuerySuitable = !!(expr && isLogsQuery(expr) && normalizedQuery.queryType === LokiQueryType.Range);
        if (!isQuerySuitable) {
          return undefined;
        }

        return {
          ...normalizedQuery,
          refId: `${REF_ID_STARTER_LOG_VOLUME}${normalizedQuery.refId}`,
          queryType: LokiQueryType.Range,
          supportingQueryType: SupportingQueryType.LogsVolume,
          expr: `sum by (level) (count_over_time(${expr}[$__auto]))`,
        };

      case SupplementaryQueryType.LogsSample:
        // it has to be a metric query
        isQuerySuitable = !!(expr && !isLogsQuery(expr));
        if (!isQuerySuitable) {
          return undefined;
        }
        return {
          ...normalizedQuery,
          queryType: LokiQueryType.Range,
          refId: `${REF_ID_STARTER_LOG_SAMPLE}${normalizedQuery.refId}`,
          expr: getLogQueryFromMetricsQuery(expr),
          maxLines: Number.isNaN(Number(options.limit)) ? this.maxLines : Number(options.limit),
        };

      default:
        return undefined;
    }
  }

  /**
   * Private method used in the `getDataProvider` for DataSourceWithSupplementaryQueriesSupport, specifically for Logs volume queries.
   * @returns An Observable of DataQueryResponse or undefined if no suitable queries are found.
   */
  private getLogsVolumeDataProvider(request: DataQueryRequest<LokiQuery>): Observable<DataQueryResponse> | undefined {
    const logsVolumeRequest = cloneDeep(request);
    const targets = logsVolumeRequest.targets
      .map((query) => this.getSupplementaryQuery({ type: SupplementaryQueryType.LogsVolume }, query))
      .filter((query): query is LokiQuery => !!query);

    if (!targets.length) {
      return undefined;
    }

    return queryLogsVolume(
      this,
      { ...logsVolumeRequest, targets },
      {
        extractLevel,
        range: request.range,
        targets: request.targets,
      }
    );
  }

  /**
   * Private method used in the `getDataProvider` for DataSourceWithSupplementaryQueriesSupport, specifically for Logs sample queries.
   * @returns An Observable of DataQueryResponse or undefined if no suitable queries are found.
   */
  private getLogsSampleDataProvider(request: DataQueryRequest<LokiQuery>): Observable<DataQueryResponse> | undefined {
    const logsSampleRequest = cloneDeep(request);
    const targets = logsSampleRequest.targets
      .map((query) => this.getSupplementaryQuery({ type: SupplementaryQueryType.LogsSample, limit: 100 }, query))
      .filter((query): query is LokiQuery => !!query);

    if (!targets.length) {
      return undefined;
    }
    return queryLogsSample(this, { ...logsSampleRequest, targets });
  }

  /**
   * Required by DataSourceApi. It executes queries based on the provided DataQueryRequest.
   * @returns An Observable of DataQueryResponse containing the query results.
   */
  query(request: DataQueryRequest<LokiQuery>): Observable<DataQueryResponse> {
    const queries = request.targets
      .map(getNormalizedLokiQuery) // used to "fix" the deprecated `.queryType` prop
      .map((q) => ({ ...q, maxLines: q.maxLines ?? this.maxLines }));

    const fixedRequest: DataQueryRequest<LokiQuery> = {
      ...request,
      targets: queries,
    };

    const streamQueries = fixedRequest.targets.filter((q) => q.queryType === LokiQueryType.Stream);
    if (
      config.featureToggles.lokiExperimentalStreaming &&
      streamQueries.length > 0 &&
      fixedRequest.rangeRaw?.to === 'now'
    ) {
      // this is still an in-development feature,
      // we do not support mixing stream-queries with normal-queries for now.
      const streamRequest = {
        ...fixedRequest,
        targets: streamQueries,
      };
      return merge(
        ...streamQueries.map((q) =>
          doLokiChannelStream(
            this.applyTemplateVariables(q, request.scopedVars),
            this, // the datasource
            streamRequest
          )
        )
      );
    }

    if (fixedRequest.liveStreaming) {
      return this.runLiveQueryThroughBackend(fixedRequest);
    }

    if (config.featureToggles.lokiQuerySplitting && requestSupportsSplitting(fixedRequest.targets)) {
      return runSplitQuery(this, fixedRequest);
    }

    const startTime = new Date();
    return this.runQuery(fixedRequest).pipe(
      tap((response) =>
        trackQuery(response, fixedRequest, startTime, { predefinedOperations: this.predefinedOperations })
      )
    );
  }

  /**
   * Executes requests through the backend using the `super.query()`, as part of the `query` method in DataSourceWithBackend.
   * @returns An Observable of transformed DataQueryResponse results from the backend.
   */
  runQuery(fixedRequest: DataQueryRequest<LokiQuery>) {
    return super
      .query(fixedRequest)
      .pipe(
        map((response) =>
          transformBackendResult(response, fixedRequest.targets, this.instanceSettings.jsonData.derivedFields ?? [])
        )
      );
  }

  /**
   * Used within the `query` to execute live queries.
   * It is intended for explore-mode and logs-queries, not metric queries.
   * @returns An Observable of DataQueryResponse with live query results or an empty response if no suitable queries are found.
   * @todo: The name says "backend" but it's actually running the query through the frontend. We should fix this.
   */
  private runLiveQueryThroughBackend(request: DataQueryRequest<LokiQuery>): Observable<DataQueryResponse> {
    // this only works in explore-mode so variables don't need to be handled,
    // and only for logs-queries, not metric queries
    const logsQueries = request.targets.filter((query) => query.expr !== '' && isLogsQuery(query.expr));

    if (logsQueries.length === 0) {
      return of({
        data: [],
        state: LoadingState.Done,
      });
    }

    const subQueries = logsQueries.map((query) => {
      const maxDataPoints = query.maxLines || this.maxLines;
      // FIXME: currently we are running it through the frontend still.
      return this.runLiveQuery(query, maxDataPoints);
    });

    return merge(...subQueries);
  }

  /**
   * Used within the `runLiveQuery` to create a live target for a Loki query.
   * @returns A LokiLiveTarget object containing the necessary information for a live query.
   */
  private createLiveTarget(target: LokiQuery, maxDataPoints: number): LokiLiveTarget {
    const query = target.expr;
    const baseUrl = this.instanceSettings.url;
    const params = serializeParams({ query });

    return {
      query,
      url: convertToWebSocketUrl(`${baseUrl}/loki/api/v1/tail?${params}`),
      refId: target.refId,
      size: maxDataPoints,
    };
  }

  /**
   * Runs live queries, which involves creating a WebSocket connection to listen for new logs.
   * It returns a slightly different DataQueryResponse compared to runQueries. It provides a single DataFrame
   * even if there are multiple Loki streams. Common labels are set on dataFrame.labels, and unique labels per row are
   * available in dataFrame.fields.labels.
   * @returns An Observable of DataQueryResponse with streaming data or an error message if live tailing encounters an issue.
   */
  private runLiveQuery = (target: LokiQuery, maxDataPoints: number): Observable<DataQueryResponse> => {
    const liveTarget = this.createLiveTarget(target, maxDataPoints);

    return this.streams.getStream(liveTarget).pipe(
      map((data) => ({
        data: data || [],
        key: `loki-${liveTarget.refId}`,
        state: LoadingState.Streaming,
      })),
      catchError((err: any) => {
        return throwError(() => `Live tailing was stopped due to following error: ${err.reason}`);
      })
    );
  };

  /**
   * Implemented as a part of DataSourceApi. Interpolates variables and adds ad hoc filters to a list of Loki queries.
   * @returns An array of expanded Loki queries with interpolated variables and ad hoc filters.
   */
  interpolateVariablesInQueries(queries: LokiQuery[], scopedVars: ScopedVars): LokiQuery[] {
    let expandedQueries = queries;
    if (queries && queries.length) {
      expandedQueries = queries.map((query) => ({
        ...query,
        datasource: this.getRef(),
        expr: this.addAdHocFilters(this.templateSrv.replace(query.expr, scopedVars, this.interpolateQueryExpr)),
      }));
    }

    return expandedQueries;
  }

  /**
   * Implemented as part of DataSourceApi. Converts a Loki query to a simple text string.
   * Used, for example, in Query history.
   * @returns A text representation of the query.
   */
  getQueryDisplayText(query: LokiQuery) {
    return query.expr;
  }

  /**
   * Retrieve the current time range.
   * @returns The current time range as provided by the timeSrv.
   */
  getTimeRange() {
    return this.timeSrv.timeRange();
  }

  /**
   * Retrieve the current time range as Loki parameters.
   * @returns An object containing the start and end times in nanoseconds since the Unix epoch.
   */
  getTimeRangeParams() {
    const timeRange = this.getTimeRange();
    return { start: timeRange.from.valueOf() * NS_IN_MS, end: timeRange.to.valueOf() * NS_IN_MS };
  }

  /**
   * Implemented as part of DataSourceWithQueryImportSupport.
   * Imports queries from AbstractQuery objects when switching between different data source types.
   * @returns A Promise that resolves to an array of Loki queries.
   */
  async importFromAbstractQueries(abstractQueries: AbstractQuery[]): Promise<LokiQuery[]> {
    await this.languageProvider.start();
    const existingKeys = this.languageProvider.labelKeys;

    if (existingKeys && existingKeys.length) {
      abstractQueries = abstractQueries.map((abstractQuery) => {
        abstractQuery.labelMatchers = abstractQuery.labelMatchers.filter((labelMatcher) => {
          return existingKeys.includes(labelMatcher.name);
        });
        return abstractQuery;
      });
    }

    return abstractQueries.map((abstractQuery) => this.languageProvider.importFromAbstractQuery(abstractQuery));
  }

  /**
   * Implemented as part of DataSourceWithQueryImportSupport.
   * Exports Loki queries to AbstractQuery objects when switching between different data source types.
   * @returns A Promise that resolves to an array of AbstractQuery objects.
   */
  async exportToAbstractQueries(queries: LokiQuery[]): Promise<AbstractQuery[]> {
    return queries.map((query) => this.languageProvider.exportToAbstractQuery(query));
  }

  /**
   * A method that wraps `getResource` from DataSourceWithBackend to perform metadata requests, with an additional check for valid URL values.
   * @returns A Promise that resolves to the data retrieved from the metadata request, or an empty array if no data is available.
   */
  async metadataRequest(url: string, params?: Record<string, string | number>, options?: Partial<BackendSrvRequest>) {
    // url must not start with a `/`, otherwise the AJAX-request
    // going from the browser will contain `//`, which can cause problems.
    if (url.startsWith('/')) {
      throw new Error(`invalid metadata request url: ${url}`);
    }

    const res = await this.getResource(url, params, options);
    return res.data || [];
  }

  /**
   * Used in `getQueryStats`. It wraps `getResource` from DataSourceWithBackend to perform a stats request
   * Specifically designed for the stats endpoint, which does not return data but includes stats directly in the response object.
   * @returns A Promise that resolves to a QueryStats object containing the statistics retrieved from the stats request.
   */
  async statsMetadataRequest(
    url: string,
    params?: Record<string, string | number>,
    options?: Partial<BackendSrvRequest>
  ): Promise<QueryStats> {
    if (url.startsWith('/')) {
      throw new Error(`invalid metadata request url: ${url}`);
    }

    return await this.getResource(url, params, options);
  }

  /**
   * Used in `getStats`. Retrieves statistics for a Loki query and processes them into a QueryStats object.
   * @returns A Promise that resolves to a QueryStats object containing the query statistics or undefined if the query is invalid.
   */
  async getQueryStats(query: LokiQuery): Promise<QueryStats | undefined> {
    // if query is invalid, clear stats, and don't request
    if (isQueryWithError(this.interpolateString(query.expr, placeHolderScopedVars))) {
      return undefined;
    }

    const labelMatchers = getStreamSelectorsFromQuery(query.expr);
    let statsForAll: QueryStats = { streams: 0, chunks: 0, bytes: 0, entries: 0 };

    for (const idx in labelMatchers) {
      const { start, end } = this.getStatsTimeRange(query, Number(idx));

      if (start === undefined || end === undefined) {
        return { streams: 0, chunks: 0, bytes: 0, entries: 0, message: 'Query size estimate not available.' };
      }

      try {
        const data = await this.statsMetadataRequest(
          'index/stats',
          {
            query: labelMatchers[idx],
            start: start,
            end: end,
          },
          { showErrorAlert: false }
        );

        statsForAll = {
          streams: statsForAll.streams + data.streams,
          chunks: statsForAll.chunks + data.chunks,
          bytes: statsForAll.bytes + data.bytes,
          entries: statsForAll.entries + data.entries,
        };
      } catch (e) {
        break;
      }
    }

    return statsForAll;
  }

  /**
   * Used within the `getQueryStats`. Retrieves the time range for a Loki stats query, adjusting it to cover the requested period.
   * In metric queries, this means extending it over the range interval.
   * @returns An object containing the start and end time in nanoseconds (NS_IN_MS) or undefined if the time range cannot be estimated.
   */

  getStatsTimeRange(query: LokiQuery, idx: number): { start: number | undefined; end: number | undefined } {
    let start: number, end: number;
    const NS_IN_MS = 1000000;
    const durationNodes = getNodesFromQuery(query.expr, [Duration]);
    const durations = durationNodes.map((d) => query.expr.substring(d.from, d.to));

    if (isLogsQuery(query.expr)) {
      // logs query with instant type can not be estimated
      if (query.queryType === LokiQueryType.Instant) {
        return { start: undefined, end: undefined };
      }
      // logs query with range type
      return this.getTimeRangeParams();
    }

    if (query.queryType === LokiQueryType.Instant) {
      // metric query with instant type

      if (!!durations[idx]) {
        // if query has a duration e.g. [1m]
        end = this.getTimeRangeParams().end;
        start = end - intervalToMs(durations[idx]) * NS_IN_MS;
        return { start, end };
      } else {
        // if query has no duration e.g. [$__interval]

        if (/(\$__auto|\$__range)/.test(query.expr)) {
          // if $__auto or $__range is used, we can estimate the time range using the selected range
          return this.getTimeRangeParams();
        }

        // otherwise we cant estimate the time range
        return { start: undefined, end: undefined };
      }
    }

    // metric query with range type
    return this.getTimeRangeParams();
  }

  /**
   * Retrieves statistics for a Loki query and returns the QueryStats object.
   * @returns A Promise that resolves to a QueryStats object or null if the query is invalid or has no statistics.
   */
  async getStats(query: LokiQuery): Promise<QueryStats | null> {
    if (!query) {
      return null;
    }

    const response = await this.getQueryStats(query);

    if (!response) {
      return null;
    }

    return Object.values(response).every((v) => v === 0) ? null : response;
  }

  /**
   * Implemented as part of DataSourceAPI and used for template variable queries.
   * @returns A Promise that resolves to an array of results from the metric find query.
   */
  async metricFindQuery(query: LokiVariableQuery | string, options?: LegacyMetricFindQueryOptions) {
    if (!query) {
      return Promise.resolve([]);
    }

    if (typeof query === 'string') {
      const interpolated = this.interpolateString(query, options?.scopedVars);
      return await this.legacyProcessMetricFindQuery(interpolated);
    }

    const interpolatedQuery = {
      ...query,
      label: this.interpolateString(query.label || '', options?.scopedVars),
      stream: this.interpolateString(query.stream || '', options?.scopedVars),
    };

    return await this.processMetricFindQuery(interpolatedQuery);
  }

  /**
   * Used within the `metricFindQuery`. Retrieves the correct variable results based on the provided LokiVariableQuery.
   * @returns A Promise that resolves to an array of variable results based on the query type and parameters.
   */

  private async processMetricFindQuery(query: LokiVariableQuery) {
    if (query.type === LokiVariableQueryType.LabelNames) {
      return this.labelNamesQuery();
    }

    if (!query.label) {
      return [];
    }

    // If we have stream selector, use /series endpoint
    if (query.stream) {
      return this.labelValuesSeriesQuery(query.stream, query.label);
    }

    return this.labelValuesQuery(query.label);
  }

  /**
   * Used in `metricFindQuery` to process legacy query strings (label_name() and label_values()) and return variable results.
   * @returns A Promise that resolves to an array of variables based on the legacy query string.
   * @todo It can be refactored in the future to return a LokiVariableQuery and be used in `processMetricFindQuery`
   * to not duplicate querying logic.
   */
  async legacyProcessMetricFindQuery(query: string) {
    const labelNames = query.match(labelNamesRegex);
    if (labelNames) {
      return await this.labelNamesQuery();
    }

    const labelValues = query.match(labelValuesRegex);
    if (labelValues) {
      // If we have stream selector, use /series endpoint
      if (labelValues[1]) {
        return await this.labelValuesSeriesQuery(labelValues[1], labelValues[2]);
      }
      return await this.labelValuesQuery(labelValues[2]);
    }

    return Promise.resolve([]);
  }

  /**
   * Private method used in `processMetricFindQuery`, `legacyProcessMetricFindQuery` and `getTagKeys` to fetch label names.
   * @returns A Promise that resolves to an array of label names as text values.
   * @todo Future exploration may involve using the `languageProvider.fetchLabels()` to avoid duplicating logic.
   */
  async labelNamesQuery() {
    const url = 'labels';
    const params = this.getTimeRangeParams();
    const result = await this.metadataRequest(url, params);
    return result.map((value: string) => ({ text: value }));
  }

  /**
   * Private method used in `processMetricFindQuery`, `legacyProcessMetricFindQuery` `getTagValues` to fetch label values.
   * @returns A Promise that resolves to an array of label values as text values.
   * @todo Future exploration may involve using the `languageProvider.fetchLabelValues()` method to avoid duplicating logic.
   */
  private async labelValuesQuery(label: string) {
    const params = this.getTimeRangeParams();
    const url = `label/${label}/values`;
    const result = await this.metadataRequest(url, params);
    return result.map((value: string) => ({ text: value }));
  }

  /**
   * Private method used in `processMetricFindQuery` and `legacyProcessMetricFindQuery` to fetch label values for specified stream.
   * @returns A Promise that resolves to an array of label values as text values.
   * @todo Future exploration may involve using the `languageProvider.fetchLabelValues()` or `languageProvider.fetchSeriesLabels()` method to avoid duplicating logic.
   */
  private async labelValuesSeriesQuery(expr: string, label: string) {
    const timeParams = this.getTimeRangeParams();
    const params = {
      ...timeParams,
      'match[]': expr,
    };
    const url = 'series';
    const streams = new Set();
    const result = await this.metadataRequest(url, params);
    result.forEach((stream: { [key: string]: string }) => {
      if (stream[label]) {
        streams.add({ text: stream[label] });
      }
    });

    return Array.from(streams);
  }

  /**
   * Used to fetch data samples, typically for autocompletion and query building to recommend parsers, labels, and values based on sampled data.
   * Currently, it works for logs data only.
   * @returns A Promise that resolves to an array of DataFrames containing data samples.
   */
  async getDataSamples(query: LokiQuery): Promise<DataFrame[]> {
    // Currently works only for logs sample
    if (!isLogsQuery(query.expr) || isQueryWithError(this.interpolateString(query.expr, placeHolderScopedVars))) {
      return [];
    }

    const lokiLogsQuery: LokiQuery = {
      expr: query.expr,
      queryType: LokiQueryType.Range,
      refId: REF_ID_DATA_SAMPLES,
      maxLines: query.maxLines || DEFAULT_MAX_LINES_SAMPLE,
      supportingQueryType: SupportingQueryType.DataSample,
    };

    const timeRange = this.getTimeRange();
    const request = makeRequest(lokiLogsQuery, timeRange, CoreApp.Unknown, REF_ID_DATA_SAMPLES, true);
    return await lastValueFrom(this.query(request).pipe(switchMap((res) => of(res.data))));
  }

  /**
   * Implemented as part of the DataSourceAPI. Retrieves tag keys that can be used for ad-hoc filtering.
   * @returns A Promise that resolves to an array of label names.
   */
  async getTagKeys() {
    return await this.labelNamesQuery();
  }

  /**
   * Implemented as part of the DataSourceAPI. Retrieves tag values that can be used for ad-hoc filtering.
   * @returns A Promise that resolves to an array of label values.
   */
  async getTagValues(options: any = {}) {
    return await this.labelValuesQuery(options.key);
  }

  /**
   * Used for interpolation logic in `interpolateVariablesInQueries` and `applyTemplateVariables`.
   * Handles escaping of special characters based on variable type and value.
   * @returns The interpolated value with appropriate character escaping.
   */
  interpolateQueryExpr(value: any, variable: any) {
    // if no multi or include all do not regexEscape
    if (!variable.multi && !variable.includeAll) {
      return lokiRegularEscape(value);
    }

    if (typeof value === 'string') {
      return lokiSpecialRegexEscape(value);
    }

    const escapedValues = lodashMap(value, lokiSpecialRegexEscape);
    return escapedValues.join('|');
  }

  /**
   * Implemented for `DataSourceWithToggleableQueryFiltersSupport`. Toggles a filter on or off based on the provided filter action.
   * It is used for example in Explore to toggle fields on and off trough log details.
   * @returns A new LokiQuery with the filter toggled as specified.
   */
  toggleQueryFilter(query: LokiQuery, filter: ToggleFilterAction): LokiQuery {
    let expression = query.expr ?? '';
    switch (filter.type) {
      case 'FILTER_FOR': {
        if (filter.options?.key && filter.options?.value) {
          const value = escapeLabelValueInSelector(filter.options.value);

          // This gives the user the ability to toggle a filter on and off.
          expression = queryHasFilter(expression, filter.options.key, '=', value)
            ? removeLabelFromQuery(expression, filter.options.key, '=', value)
            : addLabelToQuery(expression, filter.options.key, '=', value);
        }
        break;
      }
      case 'FILTER_OUT': {
        if (filter.options?.key && filter.options?.value) {
          const value = escapeLabelValueInSelector(filter.options.value);

          /**
           * If there is a filter with the same key and value, remove it.
           * This prevents the user from seeing no changes in the query when they apply
           * this filter.
           */
          if (queryHasFilter(expression, filter.options.key, '=', value)) {
            expression = removeLabelFromQuery(expression, filter.options.key, '=', value);
          }

          expression = addLabelToQuery(expression, filter.options.key, '!=', value);
        }
        break;
      }
      default:
        break;
    }
    return { ...query, expr: expression };
  }

  /**
   * Implemented for `DataSourceWithToggleableQueryFiltersSupport`. Checks if a query expression contains a filter based on the provided filter options.
   * @returns A boolean value indicating whether the filter exists in the query expression.
   */
  queryHasFilter(query: LokiQuery, filter: QueryFilterOptions): boolean {
    let expression = query.expr ?? '';
    return queryHasFilter(expression, filter.key, '=', filter.value);
  }

  /**
   * Implemented as part of `DataSourceWithQueryModificationSupportSupport`. Used to modify a query based on the provided action.
   * It is used, for example, in the Query Builder to apply hints such as parsers, operations, etc.
   * @returns A new LokiQuery with the specified modification applied.
   */
  modifyQuery(query: LokiQuery, action: QueryFixAction): LokiQuery {
    let expression = query.expr ?? '';
    // NB: Usually the labelKeys should be fetched and cached in the datasource,
    // but there might be some edge cases where this wouldn't be the case.
    // However the changed would make this method `async`.
    const allLabels = this.languageProvider.getLabelKeys();
    switch (action.type) {
      case 'ADD_FILTER': {
        if (action.options?.key && action.options?.value) {
          const value = escapeLabelValueInSelector(action.options.value);
          expression = addLabelToQuery(
            expression,
            action.options.key,
            '=',
            value,
            allLabels.includes(action.options.key) === false
          );
        }
        break;
      }
      case 'ADD_FILTER_OUT': {
        if (action.options?.key && action.options?.value) {
          const value = escapeLabelValueInSelector(action.options.value);
          expression = addLabelToQuery(
            expression,
            action.options.key,
            '!=',
            value,
            allLabels.includes(action.options.key) === false
          );
        }
        break;
      }
      case 'ADD_LOGFMT_PARSER': {
        expression = addParserToQuery(expression, 'logfmt');
        break;
      }
      case 'ADD_JSON_PARSER': {
        expression = addParserToQuery(expression, 'json');
        break;
      }
      case 'ADD_UNPACK_PARSER': {
        expression = addParserToQuery(expression, 'unpack');
        break;
      }
      case 'ADD_NO_PIPELINE_ERROR': {
        expression = addNoPipelineErrorToQuery(expression);
        break;
      }
      case 'ADD_LEVEL_LABEL_FORMAT': {
        if (action.options?.originalLabel && action.options?.renameTo) {
          expression = addLabelFormatToQuery(expression, {
            renameTo: action.options.renameTo,
            originalLabel: action.options.originalLabel,
          });
        }
        break;
      }
      case 'ADD_LABEL_FILTER': {
        const parserPositions = getParserPositions(query.expr);
        const labelFilterPositions = getLabelFilterPositions(query.expr);
        const lastPosition = findLastPosition([...parserPositions, ...labelFilterPositions]);
        const filter = toLabelFilter('', '', '=');
        expression = addFilterAsLabelFilter(expression, [lastPosition], filter);
        break;
      }
      case 'ADD_STRING_FILTER':
      case 'ADD_LINE_FILTER': {
        expression = addLineFilter(expression, action.options?.value);
        break;
      }
      case 'ADD_STRING_FILTER_OUT':
      case 'ADD_LINE_FILTER_OUT': {
        expression = addLineFilter(expression, action.options?.value, '!=');
        break;
      }
      default:
        break;
    }
    return { ...query, expr: expression };
  }

  /**
   * Implemented as part of `DataSourceWithQueryModificationSupportSupport`. Returns a list of operation
   * types that are supported by `modifyQuery()`.
   */
  getSupportedQueryModifications()
  {
    return [
      'ADD_FILTER',
      'ADD_FILTER_OUT',
      'ADD_LOGFMT_PARSER',
      'ADD_JSON_PARSER',
      'ADD_UNPACK_PARSER',
      'ADD_NO_PIPELINE_ERROR',
      'ADD_LEVEL_LABEL_FORMAT',
      'ADD_LABEL_FILTER',
      'ADD_STRING_FILTER',
      'ADD_STRING_FILTER_OUT'
    ];
  }

  /**
   * Part of `DataSourceWithLogsContextSupport`, used to retrieve log context for a log row.
   * @returns A promise that resolves to an object containing the log context data as DataFrames.
   */
  getLogRowContext = async (
    row: LogRowModel,
    options?: LogRowContextOptions,
    origQuery?: DataQuery
  ): Promise<{ data: DataFrame[] }> => {
    return await this.logContextProvider.getLogRowContext(row, options, getLokiQueryFromDataQuery(origQuery));
  };
  /**
   * Part of `DataSourceWithLogsContextSupport`, used to retrieve the log context query for the provided log row and original query.
   * @returns A promise that resolves to a DataQuery representing the log context query.
   */
  getLogRowContextQuery = async (
    row: LogRowModel,
    options?: LogRowContextOptions,
    origQuery?: DataQuery
  ): Promise<DataQuery> => {
    return await this.logContextProvider.getLogRowContextQuery(row, options, getLokiQueryFromDataQuery(origQuery));
  };

  /**
   * Part of `DataSourceWithLogsContextSupport`, used to retrieve the log context UI for the provided log row and original query.
   * @returns A React component or element representing the log context UI for the log row.
   */
  getLogRowContextUi(row: LogRowModel, runContextQuery: () => void, origQuery: DataQuery): React.ReactNode {
    return this.logContextProvider.getLogRowContextUi(row, runContextQuery, getLokiQueryFromDataQuery(origQuery));
  }

  /**
   * Implemented as part of the DataSourceAPI. It allows the datasource to serve as a source of annotations for a dashboard.
   * @returns A promise that resolves to an array of AnnotationEvent objects representing the annotations for the dashboard.
   * @todo This is deprecated and it is recommended to use the `AnnotationSupport` feature for annotations.
   */
  async annotationQuery(options: any): Promise<AnnotationEvent[]> {
    const { expr, maxLines, instant, tagKeys = '', titleFormat = '', textFormat = '' } = options.annotation;

    if (!expr) {
      return [];
    }

    const id = `${REF_ID_STARTER_ANNOTATION}${options.annotation.name}`;

    const query: LokiQuery = {
      refId: id,
      expr,
      maxLines,
      instant,
      queryType: instant ? LokiQueryType.Instant : LokiQueryType.Range,
    };

    const request = makeRequest(query, options.range, CoreApp.Dashboard, id);

    const { data } = await lastValueFrom(this.query(request));

    const annotations: AnnotationEvent[] = [];
    const splitKeys: string[] = tagKeys.split(',').filter((v: string) => v !== '');

    for (const frame of data) {
      const view = new DataFrameView<{ Time: string; Line: string; labels: Labels }>(frame);

      view.forEach((row) => {
        const { labels } = row;

        const maybeDuplicatedTags = Object.entries(labels)
          .map(([key, val]) => [key, val.trim()]) // trim all label-values
          .filter(([key, val]) => {
            if (val === '') {
              // remove empty
              return false;
            }

            // if tags are specified, remove label if does not match tags
            if (splitKeys.length && !splitKeys.includes(key)) {
              return false;
            }

            return true;
          })
          .map(([key, val]) => val); // keep only the label-value

        // remove duplicates
        const tags = Array.from(new Set(maybeDuplicatedTags));

        annotations.push({
          time: new Date(row.Time).valueOf(),
          title: renderLegendFormat(titleFormat, labels),
          text: renderLegendFormat(textFormat, labels) || row.Line,
          tags,
        });
      });
    }

    return annotations;
  }

  /**
   * Adds ad hoc filters to a query expression, handling proper escaping of filter values.
   * @returns The query expression with ad hoc filters and correctly escaped values.
   * @todo this.templateSrv.getAdhocFilters() is deprecated
   */
  addAdHocFilters(queryExpr: string) {
    const adhocFilters = this.templateSrv.getAdhocFilters(this.name);
    let expr = replaceVariables(queryExpr);

    expr = adhocFilters.reduce((acc: string, filter: { key: string; operator: string; value: string }) => {
      const { key, operator } = filter;
      let { value } = filter;
      if (isRegexSelector(operator)) {
        // Adhoc filters don't support multiselect, therefore if user selects regex operator
        // we are going to consider value to be regex filter and use lokiRegularEscape
        // that does not escape regex special characters (e.g. .*test.* => .*test.*)
        value = lokiRegularEscape(value);
      } else {
        // Otherwise, we want to escape special characters in value
        value = escapeLabelValueInSelector(value, operator);
      }
      return addLabelToQuery(acc, key, operator, value);
    }, expr);

    return returnVariables(expr);
  }

  /**
   * Filters out queries that are empty or hidden. Used when running queries through backend.
   * It is called from DatasourceWithBackend.
   * @returns `true` if the query is not hidden and its expression is not empty; `false` otherwise.
   */
  filterQuery(query: LokiQuery): boolean {
    if (query.hide || query.expr === '') {
      return false;
    }
    return true;
  }

  /**
   * Applies template variables and add hoc filters to a query. Used when running queries through backend.
   * It is called from DatasourceWithBackend.
   * @returns A modified Loki query with template variables and ad hoc filters applied.
   */
  applyTemplateVariables(target: LokiQuery, scopedVars: ScopedVars): LokiQuery {
    // We want to interpolate these variables on backend because we support using them in
    // alerting/ML queries and we want to have consistent interpolation for all queries
    const { __auto, __interval, __interval_ms, __range, __range_s, __range_ms, ...rest } = scopedVars || {};

    const exprWithAdHoc = this.addAdHocFilters(target.expr);

    return {
      ...target,
      legendFormat: this.templateSrv.replace(target.legendFormat, rest),
      expr: this.templateSrv.replace(exprWithAdHoc, rest, this.interpolateQueryExpr),
    };
  }

  /**
   * Interpolates template variables in a given string. Template variables are passed trough scopedVars.
   * @returns The string with template variables replaced by their values.
   */
  interpolateString(string: string, scopedVars?: ScopedVars) {
    return this.templateSrv.replace(string, scopedVars, this.interpolateQueryExpr);
  }

  /**
   * Retrieves and returns a list of variable names used in the template service.
   * Used for example in the Query Builder to populate the variable dropdown with template variables.
   * @returns An array of variable names, each prefixed with '$'.
   */
  getVariables(): string[] {
    return this.templateSrv.getVariables().map((v) => `$${v.name}`);
  }
  /**
   * Retrieves query hints for query improvements based on a Loki query and its result data.
   * Used in Query builder to provide hints for query improvements, such as adding a parser, etc.
   * @returns An array of query hints for potential query improvements.
   */
  getQueryHints(query: LokiQuery, result: DataFrame[]): QueryHint[] {
    return getQueryHints(query.expr, result);
  }

  /**
   * Get a default LokiQuery based on the specified app. Currently used in UnifiedAlerting.
   * @returns A default LokiQuery object with appropriate settings for the given application.
   */
  getDefaultQuery(app: CoreApp): LokiQuery {
    const defaults = { refId: 'A', expr: '' };

    if (app === CoreApp.UnifiedAlerting) {
      return {
        ...defaults,
        queryType: LokiQueryType.Instant,
      };
    }

    return {
      ...defaults,
      queryType: LokiQueryType.Range,
    };
  }
}

// NOTE: these two functions are very similar to the escapeLabelValueIn* functions
// in language_utils.ts, but they are not exactly the same algorithm, and we found
// no way to reuse one in the another or vice versa.
export function lokiRegularEscape(value: any) {
  if (typeof value === 'string') {
    return value.replace(/'/g, "\\\\'");
  }
  return value;
}

export function lokiSpecialRegexEscape(value: any) {
  if (typeof value === 'string') {
    return lokiRegularEscape(value.replace(/\\/g, '\\\\\\\\').replace(/[$^*{}\[\]+?.()|]/g, '\\\\$&'));
  }
  return value;
}

function extractLevel(dataFrame: DataFrame): LogLevel {
  let valueField;
  try {
    valueField = new FieldCache(dataFrame).getFirstFieldOfType(FieldType.number);
  } catch {}
  return valueField?.labels ? getLogLevelFromLabels(valueField.labels) : LogLevel.unknown;
}

function getLogLevelFromLabels(labels: Labels): LogLevel {
  const labelNames = ['level', 'lvl', 'loglevel'];
  let levelLabel;
  for (let labelName of labelNames) {
    if (labelName in labels) {
      levelLabel = labelName;
      break;
    }
  }
  return levelLabel ? getLogLevelFromKey(labels[levelLabel]) : LogLevel.unknown;
}
