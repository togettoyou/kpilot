import { useIntl, useModel, useParams } from '@umijs/max';
import {
  Card,
  Col,
  Empty,
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

  const nodeSeries = (key: string) =>
    (nodes.data?.series?.[key] ?? []).map((s: NodeMetricSeries) => ({
      name: s.nodeName || s.instance,
      points: s.points,
    }));

  const podSeries = (key: string) =>
    (pods.data?.series?.[key] ?? []).map((s: PodMetricSeries) => ({
      name: `${s.namespace}/${s.pod}`,
      points: s.points,
    }));

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

          {/* Cluster KPI strip */}
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12} lg={6}>
              <Card size="small" styles={{ body: { padding: 16 } }}>
                <Statistic
                  title={intl.formatMessage({ id: 'pages.monitoring.kpi.nodes' })}
                  value={snap?.nodesReady ?? 0}
                  suffix={`/ ${snap?.nodesTotal ?? 0}`}
                />
              </Card>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Card size="small" styles={{ body: { padding: 16 } }}>
                <div style={{ textAlign: 'center' }}>
                  <Typography.Text
                    type="secondary"
                    style={{ fontSize: 12, display: 'block', marginBottom: 8 }}
                  >
                    {intl.formatMessage({ id: 'pages.monitoring.kpi.cpu' })}
                  </Typography.Text>
                  <Progress
                    type="dashboard"
                    percent={dash(cpuPct).pct}
                    strokeColor={dash(cpuPct).fillColor}
                    size={120}
                    format={(p) => `${(p ?? 0).toFixed(1)}%`}
                  />
                </div>
              </Card>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Card size="small" styles={{ body: { padding: 16 } }}>
                <div style={{ textAlign: 'center' }}>
                  <Typography.Text
                    type="secondary"
                    style={{ fontSize: 12, display: 'block', marginBottom: 8 }}
                  >
                    {intl.formatMessage({ id: 'pages.monitoring.kpi.mem' })}
                  </Typography.Text>
                  <Progress
                    type="dashboard"
                    percent={dash(memPct).pct}
                    strokeColor={dash(memPct).fillColor}
                    size={120}
                    format={(p) => `${(p ?? 0).toFixed(1)}%`}
                  />
                </div>
              </Card>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Card
                size="small"
                styles={{ body: { padding: 16 } }}
                title={
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {intl.formatMessage({ id: 'pages.monitoring.kpi.pods' })}
                    <Typography.Text strong style={{ marginLeft: 8 }}>
                      {snap?.podsTotal ?? 0}
                    </Typography.Text>
                  </Typography.Text>
                }
              >
                <Space wrap>
                  {phaseEntries.length === 0 ? (
                    <Typography.Text type="secondary">
                      {intl.formatMessage({
                        id: 'pages.monitoring.kpi.pods.empty',
                      })}
                    </Typography.Text>
                  ) : (
                    phaseEntries.map(([phase, n]) => (
                      <Tag key={phase} color={phaseColor(phase)}>
                        {phase} {n}
                      </Tag>
                    ))
                  )}
                </Space>
              </Card>
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
                  />
                </Col>
                <Col xs={24} xl={12}>
                  <MultiSeriesChart
                    titleId="pages.monitoring.metric.memByNode"
                    unit="%"
                    yMax={100}
                    series={nodeSeries('mem')}
                    dark={dark}
                  />
                </Col>
                <Col xs={24} xl={12}>
                  <MultiSeriesChart
                    titleId="pages.monitoring.metric.diskByNode"
                    unit="%"
                    yMax={100}
                    series={nodeSeries('disk')}
                    dark={dark}
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
                  />
                </Col>
              </Row>
            </Suspense>
          </Card>

          {/* Pod-level panels */}
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
