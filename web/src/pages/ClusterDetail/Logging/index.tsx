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
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { useThemeMode } from 'antd-style';
import React, { lazy, Suspense, useCallback, useMemo, useState } from 'react';

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
const LoggingPage: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const { isDarkMode } = useThemeMode();

  const [query, setQuery] = useState('*');
  const [rangeMin, setRangeMin] = useState(60);
  const [limit, setLimit] = useState(200);
  // submitted{Query,Range,Limit,Anchor} = the params backing the
  // currently-displayed results. We update them on submit so editing
  // the query doesn't immediately reflow the chart underneath.
  const [submitted, setSubmitted] = useState<{
    query: string;
    rangeMin: number;
    limit: number;
    anchor: number;
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
    const q = query.trim() || '*';
    const anchor = Date.now();
    const to = new Date(anchor).toISOString();
    const from = new Date(anchor - rangeMin * 60_000).toISOString();
    setSubmitted({ query: q, rangeMin, limit, anchor });

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
