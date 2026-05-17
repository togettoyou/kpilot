import { useIntl, useModel, useParams } from '@umijs/max';
import {
  Card,
  Col,
  Empty,
  Input,
  Progress,
  Radio,
  Result,
  Row,
  Space,
  Spin,
  Statistic,
  Tag,
  theme,
  Typography,
} from 'antd';
import { useThemeMode } from 'antd-style';
import React, { lazy, Suspense, useMemo, useState } from 'react';

import { useClusterRequest } from '@/hooks/useClusterRequest';
import {
  getClusterMetrics,
  getNodeMetrics,
  getPodMetrics,
  type MetricsRange,
  type NodeMetricSeries,
  type PodMetricSeries,
} from '@/services/kpilot/monitoring';
import {
  isResourceNotAvailable,
  NotInstalled,
  RefreshControl,
  useAutoRefresh,
} from '@/pages/Compute/Volcano/shared/Layout';
import { usageColor } from '@/pages/Compute/Volcano/shared/utils';

// Heavy chart component split off so the cluster-detail bundle doesn't
// pay for @ant-design/plots until this page is actually opened.
const MultiSeriesChart = lazy(() => import('./MonitoringCharts'));

const RANGES: MetricsRange[] = ['1h', '24h', '7d', '30d'];

// /clusters/:id/monitoring — fully self-rendered, no Grafana iframe.
// Three drill-down levels (cluster KPI / node trends / Pod top-N)
// each pull from their own PromQL handler. Hard requirement is
// victoria-metrics; node-exporter and kube-state-metrics are soft
// dependencies (their panels just go empty when missing).
const MonitoringPage: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const { isDarkMode } = useThemeMode();
  const { token } = theme.useToken();
  const namespaceModel = useModel('namespace');
  const ns = clusterId ? namespaceModel.get(clusterId).selected : '';

  const [range, setRange] = useState<MetricsRange>('1h');
  // Free-text name filters for the node + pod sections. Both filters
  // run client-side over the already-fetched series (node-metrics
  // returns ALL nodes; pod-metrics returns the server-side top-N,
  // capped at 100 — large clusters use the filter to narrow which
  // pods are visible without re-fetching).
  const [nodeFilter, setNodeFilter] = useState('');
  const [podFilter, setPodFilter] = useState('');

  const cluster = useClusterRequest(
    () => getClusterMetrics(clusterId!, range),
    [clusterId, range],
    { ready: !!clusterId },
  );
  const nodes = useClusterRequest(
    () => getNodeMetrics(clusterId!, range),
    [clusterId, range],
    { ready: !!clusterId },
  );
  const pods = useClusterRequest(
    () => getPodMetrics(clusterId!, range, ns, 20),
    [clusterId, range, ns],
    { ready: !!clusterId },
  );

  const refresh = () => {
    cluster.refresh();
    nodes.refresh();
    pods.refresh();
  };
  const [interval, setIntervalMs] = useAutoRefresh(refresh, !!clusterId);

  const snap = cluster.data?.snapshot;
  const phaseEntries = useMemo(
    () => Object.entries(snap?.podsByPhase ?? {}),
    [snap],
  );
  // Project the cluster trend response into the chart's series shape.
  const clusterCpuSeries = useMemo(
    () => [
      {
        name: intl.formatMessage({ id: 'pages.monitoring.metric.cpu' }),
        points: cluster.data?.series?.cpu?.points ?? [],
      },
    ],
    [cluster.data, intl],
  );
  const clusterMemSeries = useMemo(
    () => [
      {
        name: intl.formatMessage({ id: 'pages.monitoring.metric.mem' }),
        points: cluster.data?.series?.mem?.points ?? [],
      },
    ],
    [cluster.data, intl],
  );

  if (!clusterId) return null;
  if (cluster.error && isResourceNotAvailable(cluster.error)) {
    return (
      <NotInstalled
        clusterId={clusterId}
        titleId="pages.monitoring.notInstalled.title"
        subTitleId="pages.monitoring.notInstalled.subTitle"
        actionId="pages.monitoring.notInstalled.action"
      />
    );
  }

  const cpuPct = snap?.cpuUtilPct ?? 0;
  const memPct = snap?.memUtilPct ?? 0;
  const dash = (pct: number) => ({
    fillColor: usageColor(pct / 100, token),
    pct: Math.min(100, Math.max(0, pct)),
  });

  const nodeFilterLower = nodeFilter.trim().toLowerCase();
  const nodeSeries = (key: string) => {
    const rows = (nodes.data?.series?.[key] ?? []).map(
      (s: NodeMetricSeries) => ({
        name: s.nodeName || s.instance,
        points: s.points,
      }),
    );
    if (!nodeFilterLower) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(nodeFilterLower));
  };

  const podFilterLower = podFilter.trim().toLowerCase();
  const podSeries = (key: string) => {
    const rows = (pods.data?.series?.[key] ?? []).map(
      (s: PodMetricSeries) => ({
        name: `${s.namespace}/${s.pod}`,
        points: s.points,
      }),
    );
    if (!podFilterLower) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(podFilterLower));
  };

  const loading = cluster.loading || nodes.loading || pods.loading;
  const dark = isDarkMode;
  const chartFallback = (
    <div style={{ textAlign: 'center', padding: 48 }}>
      <Spin />
    </div>
  );

  return (
    <div className="p-6">
      <Spin spinning={loading && !cluster.data}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {/* Header — range picker + refresh */}
          <Card size="small" styles={{ body: { padding: '8px 16px' } }}>
            <Row justify="space-between" align="middle" wrap>
              <Col>
                <Space>
                  <Typography.Text strong>
                    {intl.formatMessage({ id: 'pages.monitoring.title' })}
                  </Typography.Text>
                  {cluster.data && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {intl.formatMessage(
                        { id: 'pages.monitoring.generatedAt' },
                        {
                          ts: new Date(cluster.data.generatedAt).toLocaleString(),
                        },
                      )}
                    </Typography.Text>
                  )}
                </Space>
              </Col>
              <Col>
                <Space>
                  <Radio.Group
                    size="small"
                    value={range}
                    onChange={(e) => setRange(e.target.value)}
                    options={RANGES.map((r) => ({ label: r, value: r }))}
                  />
                  <RefreshControl
                    interval={interval}
                    setInterval={setIntervalMs}
                    refresh={refresh}
                    loading={loading}
                  />
                </Space>
              </Col>
            </Row>
          </Card>

          {/* Cluster KPI strip — 4 cards share the same grid:
                Top:    title (small) + value (big) on the left,
                        optional Progress.dashboard on the right.
                Bottom: one-line secondary info (cores / GiB / phase
                        tags), pinned to the card's bottom edge by
                        flex justify-between so heights line up across
                        the row even when one card has nothing to put
                        in its bottom row. */}
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12} lg={6}>
              <KPICard
                title={intl.formatMessage({ id: 'pages.monitoring.kpi.nodes' })}
                value={snap?.nodesReady ?? 0}
                suffix={`/ ${snap?.nodesTotal ?? 0}`}
                dashPct={
                  snap?.nodesTotal
                    ? (100 * (snap.nodesReady ?? 0)) / snap.nodesTotal
                    : undefined
                }
                dashColor={
                  snap?.nodesTotal && snap.nodesReady === snap.nodesTotal
                    ? usageColor(0, token)
                    : usageColor(0.9, token)
                }
                bottom={
                  snap && snap.nodesTotal > 0 && snap.nodesReady < snap.nodesTotal
                    ? intl.formatMessage(
                        { id: 'pages.monitoring.kpi.nodes.degraded' },
                        { n: snap.nodesTotal - snap.nodesReady },
                      )
                    : ''
                }
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <KPICard
                title={intl.formatMessage({ id: 'pages.monitoring.kpi.cpu' })}
                value={cpuPct.toFixed(1)}
                suffix="%"
                dashPct={dash(cpuPct).pct}
                dashColor={dash(cpuPct).fillColor}
                bottom={
                  snap?.cpuTotalCores
                    ? intl.formatMessage(
                        { id: 'pages.monitoring.kpi.cpu.absolute' },
                        {
                          used: (snap.cpuUsedCores ?? 0).toFixed(1),
                          total: Math.round(snap.cpuTotalCores),
                        },
                      )
                    : intl.formatMessage({
                        id: 'pages.monitoring.kpi.absolute.unavailable',
                      })
                }
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <KPICard
                title={intl.formatMessage({ id: 'pages.monitoring.kpi.mem' })}
                value={memPct.toFixed(1)}
                suffix="%"
                dashPct={dash(memPct).pct}
                dashColor={dash(memPct).fillColor}
                bottom={
                  snap?.memTotalBytes
                    ? intl.formatMessage(
                        { id: 'pages.monitoring.kpi.mem.absolute' },
                        {
                          used: formatGiB(snap.memUsedBytes ?? 0),
                          total: formatGiB(snap.memTotalBytes),
                        },
                      )
                    : intl.formatMessage({
                        id: 'pages.monitoring.kpi.absolute.unavailable',
                      })
                }
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <KPICard
                title={intl.formatMessage({ id: 'pages.monitoring.kpi.pods' })}
                value={snap?.podsTotal ?? 0}
                bottom={
                  phaseEntries.length === 0 ? (
                    intl.formatMessage({ id: 'pages.monitoring.kpi.pods.empty' })
                  ) : (
                    <Space size={[4, 4]} wrap>
                      {phaseEntries.map(([phase, n]) => (
                        <Tag
                          key={phase}
                          color={phaseColor(phase)}
                          style={{ marginInlineEnd: 0 }}
                        >
                          {phase} {n}
                        </Tag>
                      ))}
                    </Space>
                  )
                }
              />
            </Col>
          </Row>

          {/* Cluster trends */}
          <Suspense fallback={chartFallback}>
            <Row gutter={[16, 16]}>
              <Col xs={24} xl={12}>
                <MultiSeriesChart
                  titleId="pages.monitoring.chart.clusterCpu"
                  unit="%"
                  yMax={100}
                  series={clusterCpuSeries}
                  dark={dark}
                />
              </Col>
              <Col xs={24} xl={12}>
                <MultiSeriesChart
                  titleId="pages.monitoring.chart.clusterMem"
                  unit="%"
                  yMax={100}
                  series={clusterMemSeries}
                  dark={dark}
                />
              </Col>
            </Row>
          </Suspense>

          {/* Node-level panels */}
          <Card
            title={intl.formatMessage({ id: 'pages.monitoring.section.nodes' })}
            extra={
              <Input.Search
                allowClear
                size="small"
                style={{ width: 220 }}
                placeholder={intl.formatMessage({
                  id: 'pages.monitoring.filter.node.placeholder',
                })}
                value={nodeFilter}
                onChange={(e) => setNodeFilter(e.target.value)}
              />
            }
            size="small"
            styles={{ body: { padding: 16 } }}
          >
            <Suspense fallback={chartFallback}>
              <Row gutter={[16, 16]}>
                <Col xs={24} xl={12}>
                  <MultiSeriesChart
                    titleId="pages.monitoring.metric.cpuByNode"
                    unit="%"
                    yMax={100}
                    series={nodeSeries('cpu')}
                    dark={dark}
                    alwaysShowLegend
                  />
                </Col>
                <Col xs={24} xl={12}>
                  <MultiSeriesChart
                    titleId="pages.monitoring.metric.memByNode"
                    unit="%"
                    yMax={100}
                    series={nodeSeries('mem')}
                    dark={dark}
                    alwaysShowLegend
                  />
                </Col>
                <Col xs={24} xl={12}>
                  <MultiSeriesChart
                    titleId="pages.monitoring.metric.diskByNode"
                    unit="%"
                    yMax={100}
                    series={nodeSeries('disk')}
                    dark={dark}
                    alwaysShowLegend
                  />
                </Col>
                <Col xs={24} xl={12}>
                  <MultiSeriesChart
                    titleId="pages.monitoring.metric.netByNode"
                    unit="MiB/s"
                    unitScale={1 / 1024 / 1024}
                    series={[
                      ...nodeSeries('netRx').map((s) => ({
                        ...s,
                        name: `${s.name} ↓`,
                      })),
                      ...nodeSeries('netTx').map((s) => ({
                        ...s,
                        name: `${s.name} ↑`,
                      })),
                    ]}
                    dark={dark}
                    alwaysShowLegend
                  />
                </Col>
              </Row>
            </Suspense>
          </Card>

          {/* Pod-level panels — server filters by namespace (driven by
              the global picker, empty = all NSes), client-side
              text filter narrows by pod name on the returned top-N. */}
          <Card
            title={
              <Space>
                <span>
                  {intl.formatMessage({ id: 'pages.monitoring.section.pods' })}
                </span>
                {ns ? (
                  <Tag>{ns}</Tag>
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {intl.formatMessage({
                      id: 'pages.monitoring.section.pods.allNs',
                    })}
                  </Typography.Text>
                )}
              </Space>
            }
            extra={
              <Input.Search
                allowClear
                size="small"
                style={{ width: 220 }}
                placeholder={intl.formatMessage({
                  id: 'pages.monitoring.filter.pod.placeholder',
                })}
                value={podFilter}
                onChange={(e) => setPodFilter(e.target.value)}
              />
            }
            size="small"
            styles={{ body: { padding: 16 } }}
          >
            {pods.data &&
            (pods.data.series?.cpu?.length ?? 0) === 0 &&
            (pods.data.series?.mem?.length ?? 0) === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={intl.formatMessage({
                  id: 'pages.monitoring.section.pods.empty',
                })}
              />
            ) : (
              <Suspense fallback={chartFallback}>
                <Row gutter={[16, 16]}>
                  <Col xs={24} xl={12}>
                    <MultiSeriesChart
                      titleId="pages.monitoring.metric.cpuByPod"
                      unit="core"
                      titleSuffix={intl.formatMessage({
                        id: 'pages.monitoring.topN',
                      })}
                      series={podSeries('cpu')}
                      dark={dark}
                      alwaysShowLegend
                    />
                  </Col>
                  <Col xs={24} xl={12}>
                    <MultiSeriesChart
                      titleId="pages.monitoring.metric.memByPod"
                      unit="GiB"
                      unitScale={1 / 1024 / 1024 / 1024}
                      titleSuffix={intl.formatMessage({
                        id: 'pages.monitoring.topN',
                      })}
                      series={podSeries('mem')}
                      dark={dark}
                      alwaysShowLegend
                    />
                  </Col>
                </Row>
              </Suspense>
            )}
          </Card>

          {/* Cluster-level error catch-all — RESOURCE_NOT_AVAILABLE is
              handled by the NotInstalled branch above. */}
          {cluster.error && !isResourceNotAvailable(cluster.error) && (
            <Result
              status="warning"
              title={intl.formatMessage({ id: 'pages.monitoring.error.title' })}
              subTitle={String(
                (cluster.error as any)?.response?.data?.message ??
                  cluster.error.message,
              )}
            />
          )}
        </Space>
      </Spin>
    </div>
  );
};

// KPICard is the shared shell for the 4 top-of-page metrics. Body is
// flex-column-justify-between so the secondary line / phase tags
// always pin to the card bottom, leaving consistent vertical
// alignment of the title + value row across all 4 cards (heights
// already match via style={{ height: '100%' }} on the Card itself).
interface KPICardProps {
  title: string;
  value: string | number;
  suffix?: React.ReactNode;
  /** Dashboard percent in [0, 100]. Omit for cards without a gauge. */
  dashPct?: number;
  dashColor?: string;
  /** Secondary content under the title row. String → rendered as
   *  secondary text; ReactNode → rendered verbatim (for tag lists). */
  bottom?: React.ReactNode;
}

function KPICard({ title, value, suffix, dashPct, dashColor, bottom }: KPICardProps) {
  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      styles={{
        body: {
          padding: 16,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          gap: 12,
        },
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <Statistic title={title} value={value} suffix={suffix} />
        {typeof dashPct === 'number' && (
          <Progress
            type="dashboard"
            percent={dashPct}
            strokeColor={dashColor}
            size={56}
            format={() => ''}
          />
        )}
      </div>
      <div
        style={{
          fontSize: 12,
          color: 'var(--ant-color-text-secondary)',
          minHeight: 22,
          lineHeight: '22px',
        }}
      >
        {bottom}
      </div>
    </Card>
  );
}

// formatGiB renders a byte count as a human-friendly GiB string, with
// MiB precision when the value is small enough that GiB rounds to 0.
// Used by the KPI absolute-memory hint.
function formatGiB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0';
  const gib = bytes / 1024 / 1024 / 1024;
  if (gib >= 100) return gib.toFixed(0);
  if (gib >= 10) return gib.toFixed(1);
  if (gib >= 1) return gib.toFixed(2);
  // Sub-GiB clusters (tiny kind / minikube setups) — show MiB.
  const mib = bytes / 1024 / 1024;
  return `${mib.toFixed(0)} MiB`;
}

function phaseColor(phase: string): string {
  switch (phase) {
    case 'Running':
      return 'green';
    case 'Pending':
      return 'gold';
    case 'Succeeded':
      return 'blue';
    case 'Failed':
      return 'red';
    default:
      return 'default';
  }
}

export default MonitoringPage;
