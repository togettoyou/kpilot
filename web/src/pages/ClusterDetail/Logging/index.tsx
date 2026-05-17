import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useIntl, useParams } from '@umijs/max';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Input,
  Result,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { useThemeMode } from 'antd-style';
import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  isResourceNotAvailable,
  NotInstalled,
} from '@/pages/Compute/Volcano/shared/Layout';
import {
  type LogLine,
  logsHistogram,
  type LogsHistogramResponse,
  type LogSearchResponse,
  searchLogs,
} from '@/services/kpilot/logs';
import { listNamespaces, listWorkloads } from '@/services/kpilot/workload';

// Heavy chart split off to keep the cluster-detail bundle lean.
const LoggingHistogram = lazy(() => import('./LoggingHistogram'));

const RANGE_PRESETS: Array<{ label: string; minutes: number }> = [
  { label: '5m', minutes: 5 },
  { label: '15m', minutes: 15 },
  { label: '1h', minutes: 60 },
  { label: '6h', minutes: 360 },
  { label: '24h', minutes: 24 * 60 },
];

// /clusters/:id/logging — self-rendered search UI for VictoriaLogs.
// Three pieces visible above the fold: the query bar (LogsQL string),
// the volume histogram, and the matching log lines. The histogram and
// the search fire in parallel against two server handlers; the user
// hits 「搜索」 (or presses Enter in the query box) to issue a new
// request.
// LogsQL stream-selector keys emitted by Vector's kubernetes_logs source
// (the source the chart we ship turns on by default). Dots in field
// names are valid LogsQL — referenced as-is, no escaping.
const FIELD_NS = 'kubernetes.pod_namespace';
const FIELD_POD = 'kubernetes.pod_name';

// composeStreamSelector turns the dropdown selection into a LogsQL stream
// selector like `{kubernetes.pod_namespace="default", kubernetes.pod_name="x"}`.
// Empty inputs mean "no filter" — return an empty string so the caller
// can compose with whatever else.
function composeStreamSelector(ns: string, pod: string): string {
  const parts: string[] = [];
  if (ns) parts.push(`${FIELD_NS}="${ns}"`);
  if (pod) parts.push(`${FIELD_POD}="${pod}"`);
  if (parts.length === 0) return '';
  return `{${parts.join(', ')}}`;
}

const LoggingPage: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const { isDarkMode } = useThemeMode();

  // Empty default — the backend treats "" as "*" so a fresh page can
  // hit Search and see all logs in the window. Removes the magic
  // asterisk users had to know to wipe before typing.
  const [query, setQuery] = useState('');
  const [rangeMin, setRangeMin] = useState(60);
  const [limit, setLimit] = useState(200);

  // Structured pickers — convenience layer that auto-builds a LogsQL
  // stream selector and back-fills it into the input. The input
  // remains source-of-truth; once the user edits it manually the
  // pickers don't reach back in.
  const [pickerNs, setPickerNs] = useState('');
  const [pickerPod, setPickerPod] = useState('');
  const [nsList, setNsList] = useState<string[]>([]);
  const [nsLoading, setNsLoading] = useState(false);
  const [podList, setPodList] = useState<string[]>([]);
  const [podLoading, setPodLoading] = useState(false);
  // submitted{Query,Range,Limit,Anchor} = the params backing the
  // currently-displayed results. We update them on submit so editing
  // the query doesn't immediately reflow the chart underneath.
  const [submitted, setSubmitted] = useState<{
    query: string;
    rangeMin: number;
    limit: number;
  } | null>(null);

  // 加载状态 + 数据;两个请求是手动触发的 useState fetch,而不是
  // useClusterRequest——因为 logging 不应该在打开页面那一刻自动跑
  // 大查询,等用户敲 Enter 再发。
  const [search, setSearch] = useState<{
    data: LogSearchResponse | null;
    error: any;
    loading: boolean;
  }>({ data: null, error: null, loading: false });
  const [histo, setHisto] = useState<{
    data: LogsHistogramResponse | null;
    loading: boolean;
  }>({ data: null, loading: false });

  const runQuery = useCallback(async () => {
    if (!clusterId) return;
    // Empty input → ask for everything. Backend mirrors this default
    // so the server-side LogsQL parser sees `*` even on first load.
    const q = query.trim() || '*';
    const nowMs = Date.now();
    const to = new Date(nowMs).toISOString();
    const from = new Date(nowMs - rangeMin * 60_000).toISOString();
    setSubmitted({ query: q, rangeMin, limit });

    setSearch({ data: null, error: null, loading: true });
    setHisto({ data: null, loading: true });
    // Parallel — histogram is cheap, search dominates wall clock.
    void Promise.allSettled([
      searchLogs(clusterId, { query: q, from, to, limit }).then(
        (data) =>
          setSearch({ data, error: null, loading: false }),
        (error) => setSearch({ data: null, error, loading: false }),
      ),
      logsHistogram(clusterId, { query: q, from, to }).then(
        (data) => setHisto({ data, loading: false }),
        () => setHisto({ data: null, loading: false }),
      ),
    ]);
  }, [clusterId, query, rangeMin, limit]);

  // Fetch the namespace list once per cluster for the structured
  // picker. Same pattern as Monitoring page — local state, not the
  // global namespace model.
  useEffect(() => {
    if (!clusterId) return;
    let cancelled = false;
    setNsLoading(true);
    listNamespaces(clusterId)
      .then((list) => {
        if (!cancelled) setNsList(list ?? []);
      })
      .catch(() => {
        if (!cancelled) setNsList([]);
      })
      .finally(() => {
        if (!cancelled) setNsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clusterId]);

  // Pods list depends on the picked namespace. Reset and refetch
  // whenever ns changes. Cluster-wide pod listing (ns="") is skipped
  // — large clusters would balloon the dropdown — so a user has to
  // pick a namespace before the pod picker becomes useful.
  useEffect(() => {
    setPickerPod('');
    setPodList([]);
    if (!clusterId || !pickerNs) return;
    let cancelled = false;
    setPodLoading(true);
    listWorkloads(clusterId, 'pods', pickerNs, 500, '')
      .then((res) => {
        if (cancelled) return;
        // Worker requests the K8s Table representation
        // (`application/json;as=Table`), so the response shape is
        // `{kind:'Table', rows:[{object:{metadata:{name}}, cells}]}`
        // — not a plain List with `.items`. Pull names from row
        // metadata; the cells[] fallback covers Tables that ship a
        // PartialObjectMetadata stripped to just labels.
        const rows = (res?.rows ?? []) as Array<{
          object?: { metadata?: { name?: string } };
          cells?: unknown[];
        }>;
        const colNames = ((res?.columnDefinitions ?? []) as Array<{
          name?: string;
        }>).map((c) => c.name ?? '');
        const nameIdx = colNames.indexOf('Name');
        const names = rows
          .map((r) => {
            const fromMeta = r.object?.metadata?.name;
            if (fromMeta) return fromMeta;
            if (nameIdx >= 0) {
              const v = r.cells?.[nameIdx];
              if (typeof v === 'string') return v;
            }
            return '';
          })
          .filter((n) => !!n)
          .sort();
        setPodList(names);
      })
      .catch(() => {
        if (!cancelled) setPodList([]);
      })
      .finally(() => {
        if (!cancelled) setPodLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clusterId, pickerNs]);

  // Auto-build the LogsQL selector into the input whenever the
  // structured picker changes. We REPLACE the input — keeping the
  // picker authoritative on its own values. Anything the user typed
  // manually after the last picker change is dropped on the next
  // change, which is the same trade-off Grafana's explore makes when
  // a label-filter chip is added.
  const onPickerChange = (nextNs: string, nextPod: string) => {
    setPickerNs(nextNs);
    setPickerPod(nextPod);
    setQuery(composeStreamSelector(nextNs, nextPod));
  };

  // Lightweight install probe on mount — fires a tiny histogram query
  // over the last minute. RESOURCE_NOT_AVAILABLE surfaces immediately
  // so the page renders the shared NotInstalled hint without forcing
  // the user to type a query first. Any other error (or success) is
  // ignored: the page falls through to the empty query bar.
  useEffect(() => {
    if (!clusterId) return;
    let cancelled = false;
    const nowMs = Date.now();
    logsHistogram(clusterId, {
      query: '*',
      from: new Date(nowMs - 60_000).toISOString(),
      to: new Date(nowMs).toISOString(),
    }).catch((error) => {
      if (cancelled) return;
      if (isResourceNotAvailable(error)) {
        setSearch({ data: null, error, loading: false });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [clusterId]);

  // Format the result lines once per response.
  const lines = useMemo<LogLine[]>(() => search.data?.lines ?? [], [search.data]);

  if (!clusterId) return null;
  if (search.error && isResourceNotAvailable(search.error)) {
    return (
      <NotInstalled
        clusterId={clusterId}
        titleId="pages.logging.notInstalled.title"
        subTitleId="pages.logging.notInstalled.subTitle"
        actionId="pages.logging.notInstalled.action"
      />
    );
  }

  return (
    <div className="p-6">
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {/* Query bar */}
        <Card size="small" styles={{ body: { padding: 16 } }}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Input
              prefix={<SearchOutlined />}
              size="large"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onPressEnter={runQuery}
              placeholder={intl.formatMessage({
                id: 'pages.logging.query.placeholder',
              })}
              allowClear
            />
            {/* Structured pickers — auto-build a LogsQL stream selector
                from namespace + pod and back-fill the input above. Pod
                list is scoped to the picked namespace; picking nothing
                clears the selector and the input. */}
            <Row gutter={[12, 12]} align="middle" wrap>
              <Col>
                <Typography.Text type="secondary">
                  {intl.formatMessage({ id: 'pages.logging.picker.namespace' })}
                </Typography.Text>
              </Col>
              <Col>
                <Select
                  size="small"
                  style={{ width: 200 }}
                  allowClear
                  showSearch
                  loading={nsLoading}
                  placeholder={intl.formatMessage({
                    id: 'pages.logging.picker.namespace.placeholder',
                  })}
                  value={pickerNs || undefined}
                  onChange={(v) => onPickerChange(v ?? '', '')}
                  options={nsList.map((n) => ({ label: n, value: n }))}
                  filterOption={(input, opt) =>
                    (opt?.label as string)
                      ?.toLowerCase()
                      .includes(input.trim().toLowerCase())
                  }
                />
              </Col>
              <Col>
                <Typography.Text type="secondary">
                  {intl.formatMessage({ id: 'pages.logging.picker.pod' })}
                </Typography.Text>
              </Col>
              <Col>
                <Select
                  size="small"
                  style={{ width: 280 }}
                  allowClear
                  showSearch
                  loading={podLoading}
                  disabled={!pickerNs}
                  placeholder={intl.formatMessage({
                    id: pickerNs
                      ? 'pages.logging.picker.pod.placeholder'
                      : 'pages.logging.picker.pod.pickNsFirst',
                  })}
                  value={pickerPod || undefined}
                  onChange={(v) => onPickerChange(pickerNs, v ?? '')}
                  options={podList.map((n) => ({ label: n, value: n }))}
                  filterOption={(input, opt) =>
                    (opt?.label as string)
                      ?.toLowerCase()
                      .includes(input.trim().toLowerCase())
                  }
                />
              </Col>
            </Row>
            <Row gutter={[12, 12]} align="middle" wrap>
              <Col>
                <Typography.Text type="secondary">
                  {intl.formatMessage({ id: 'pages.logging.range' })}
                </Typography.Text>
              </Col>
              <Col>
                <Space size={4} wrap>
                  {RANGE_PRESETS.map((r) => (
                    <Button
                      key={r.minutes}
                      size="small"
                      type={rangeMin === r.minutes ? 'primary' : 'default'}
                      onClick={() => setRangeMin(r.minutes)}
                    >
                      {r.label}
                    </Button>
                  ))}
                </Space>
              </Col>
              <Col flex="auto" />
              <Col>
                <Space>
                  <Typography.Text type="secondary">
                    {intl.formatMessage({ id: 'pages.logging.limit' })}
                  </Typography.Text>
                  <Input
                    size="small"
                    style={{ width: 80 }}
                    value={limit}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (!Number.isNaN(v) && v > 0 && v <= 1000) setLimit(v);
                    }}
                  />
                  <Button
                    type="primary"
                    icon={<SearchOutlined />}
                    onClick={runQuery}
                    loading={search.loading}
                  >
                    {intl.formatMessage({ id: 'pages.logging.search' })}
                  </Button>
                  <Button
                    icon={<ReloadOutlined />}
                    onClick={runQuery}
                    disabled={!submitted}
                  />
                </Space>
              </Col>
            </Row>
          </Space>
        </Card>

        {/* Histogram */}
        {submitted && (
          <Card
            size="small"
            title={
              <Space>
                <Typography.Text strong>
                  {intl.formatMessage({ id: 'pages.logging.histogram.title' })}
                </Typography.Text>
                {histo.data && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {intl.formatMessage(
                      { id: 'pages.logging.histogram.total' },
                      { n: histo.data.total },
                    )}
                  </Typography.Text>
                )}
              </Space>
            }
            styles={{ body: { padding: 12 } }}
          >
            <Spin spinning={histo.loading}>
              <Suspense
                fallback={
                  <div style={{ textAlign: 'center', padding: 32 }}>
                    <Spin />
                  </div>
                }
              >
                <LoggingHistogram
                  points={histo.data?.points ?? []}
                  dark={isDarkMode}
                />
              </Suspense>
            </Spin>
          </Card>
        )}

        {/* Search error (non-NotInstalled) */}
        {search.error && !isResourceNotAvailable(search.error) && (
          <Result
            status="warning"
            title={intl.formatMessage({ id: 'pages.logging.error.title' })}
            subTitle={String(
              (search.error as any)?.response?.data?.message ??
                search.error.message,
            )}
          />
        )}

        {/* Truncation banner */}
        {search.data?.truncated && (
          <Alert
            type="info"
            showIcon
            message={intl.formatMessage(
              { id: 'pages.logging.truncated' },
              { n: search.data.lines.length },
            )}
          />
        )}

        {/* Results list */}
        {submitted && (
          <Card
            size="small"
            title={
              <Space>
                <Typography.Text strong>
                  {intl.formatMessage({ id: 'pages.logging.results.title' })}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {intl.formatMessage(
                    { id: 'pages.logging.results.count' },
                    { n: lines.length },
                  )}
                </Typography.Text>
              </Space>
            }
            styles={{ body: { padding: 0 } }}
          >
            <Spin spinning={search.loading}>
              {lines.length === 0 && !search.loading ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  style={{ padding: 32 }}
                  description={intl.formatMessage({
                    id: 'pages.logging.results.empty',
                  })}
                />
              ) : (
                <div style={{ maxHeight: 600, overflow: 'auto' }}>
                  {lines.map((ln, i) => (
                    <LogRow key={i} line={ln} />
                  ))}
                </div>
              )}
            </Spin>
          </Card>
        )}
      </Space>
    </div>
  );
};

// LogRow renders one log line as a wrapped pre block with the
// hostname/namespace/pod chips prefixed for context. Keeps things
// compact — full structured fields go behind a click-to-expand later
// if anyone asks.
function LogRow({ line }: { line: LogLine }) {
  const t = new Date(line.time);
  const ts = Number.isNaN(t.getTime())
    ? line.time
    : t.toLocaleString();
  return (
    <div
      style={{
        padding: '6px 12px',
        borderBottom: '1px solid var(--ant-color-split)',
        fontFamily:
          'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
        fontSize: 12,
        lineHeight: 1.5,
        wordBreak: 'break-all',
        whiteSpace: 'pre-wrap',
      }}
    >
      <Space size={6} wrap style={{ marginRight: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {ts}
        </Typography.Text>
        {line.namespace && (
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
            {line.namespace}
          </Tag>
        )}
        {line.pod && (
          <Tag style={{ marginInlineEnd: 0 }}>{line.pod}</Tag>
        )}
        {line.container && (
          <Tag color="default" style={{ marginInlineEnd: 0 }}>
            {line.container}
          </Tag>
        )}
      </Space>
      <span>{line.message}</span>
    </div>
  );
}

export default LoggingPage;
