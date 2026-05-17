import { useIntl, useParams } from '@umijs/max';
import {
  Card,
  Col,
  Empty,
  Input,
  Progress,
  Radio,
  Result,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Tag,
  theme,
  Typography,
} from 'antd';
import { useThemeMode } from 'antd-style';
import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';

import { useClusterRequest } from '@/hooks/useClusterRequest';
import {
  getClusterMetrics,
  getNodeMetrics,
  getPodHealth,
  getPodMetrics,
  type MetricsRange,
  type NodeMetricSeries,
  type PodHealthRow,
  type PodMetricSeries,
} from '@/services/kpilot/monitoring';
import { listNamespaces } from '@/services/kpilot/workload';
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

  const [range, setRange] = useState<MetricsRange>('1h');
  // Pod-scope namespace picker — deliberately NOT wired to the global
  // namespace model used by Workloads. The monitoring view starts with
  // "all namespaces" every time so a returning operator gets the
  // cluster-wide picture by default; switching is a per-visit choice
  // for drill-down.
  const [podNs, setPodNs] = useState('');
  const [nsList, setNsList] = useState<string[]>([]);
  const [nsLoading, setNsLoading] = useState(false);
  // Free-text name filters for the node + pod sections. Both filters
  // run client-side over the already-fetched series (node-metrics
  // returns ALL nodes; pod-metrics returns the server-side top-N,
  // capped at 100 — large clusters use the filter to narrow which
  // pods are visible without re-fetching). Pod filter matches the
  // pod name only (namespace is already a hard server-side filter).
  const [nodeFilter, setNodeFilter] = useState('');
  const [podFilter, setPodFilter] = useState('');

  // Fetch the namespace list once per cluster for the pod-scope picker.
  // Not using the namespace model: that one persists state across
  // navigation (deliberate for Workloads). Here we want fresh local
  // state.
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
    () => getPodMetrics(clusterId!, range, podNs, 20),
    [clusterId, range, podNs],
    { ready: !!clusterId },
  );
  // Pod health (restart + OOM) is range-independent — counters are
  // current values. Refetches on the pod-scope namespace so the table
  // tracks the same scope as the chart panels below.
  const podHealth = useClusterRequest(
    () => getPodHealth(clusterId!, podNs, 10),
    [clusterId, podNs],
    { ready: !!clusterId },
  );

  const refresh = () => {
    cluster.refresh();
    nodes.refresh();
    pods.refresh();
    podHealth.refresh();
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
  const pendingPodsSeries = useMemo(
    () => [
      {
        name: intl.formatMessage({ id: 'pages.monitoring.metric.pendingPods' }),
        points: cluster.data?.series?.pendingPods?.points ?? [],
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
  // First-load placeholder. Without this, the body-spanning Spin
  // ended up at the vertical center of a tall (mostly-empty) page —
  // operators had to scroll past two viewports of skeleton Cards to
  // see that the page was still loading. A small spinner anchored to
  // the top of the page is visible immediately. After data lands we
  // never show this overlay again; per-Card loading + the refresh
  // button cover incremental refetches.
  if (!cluster.data && !cluster.error) {
    return (
      <div className="p-6" style={{ textAlign: 'center' }}>
        <Spin size="large" style={{ marginTop: 48 }} />
      </div>
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
  // Series name keeps the namespace prefix so multi-NS views can tell
  // pods apart in the legend, but the filter only matches the pod
  // portion — namespace scoping is the picker's job.
  const podSeries = (key: string) => {
    const rows = (pods.data?.series?.[key] ?? []).map(
      (s: PodMetricSeries) => ({
        name: `${s.namespace}/${s.pod}`,
        pod: s.pod,
        points: s.points,
      }),
    );
    if (!podFilterLower) return rows;
    return rows.filter((r) => r.pod.toLowerCase().includes(podFilterLower));
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
                      {/* Always emphasize Pending — it's the operational
                          signal that something is stuck waiting to
                          schedule, drives a different remediation
                          path than the rest. */}
                      {(snap?.podsPending ?? 0) > 0 && (
                        <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                          {intl.formatMessage(
                            { id: 'pages.monitoring.kpi.pods.pending' },
                            { n: snap?.podsPending ?? 0 },
                          )}
                        </Tag>
                      )}
                      {phaseEntries
                        .filter(([phase]) => phase !== 'Pending')
                        .map(([phase, n]) => (
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
              <Col xs={24} xl={12}>
                <MultiSeriesChart
                  titleId="pages.monitoring.chart.pendingPods"
                  unit=""
                  series={pendingPodsSeries}
                  dark={dark}
                />
              </Col>
            </Row>
          </Suspense>

          {/* Pod health — Restart + OOM top-N. Counter values, not
              rates: presented as a table, not a chart. Empty section
              when no problematic pods exist (every healthy cluster). */}
          <Card
            title={intl.formatMessage({ id: 'pages.monitoring.section.podHealth' })}
            size="small"
            styles={{ body: { padding: 16 } }}
          >
            {podHealth.data && podHealth.data.rows.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={intl.formatMessage({
                  id: 'pages.monitoring.podHealth.empty',
                })}
              />
            ) : (
              <table style={{ width: '100%', fontSize: 13 }}>
                <thead>
                  <tr style={{ color: 'var(--ant-color-text-secondary)', textAlign: 'left' }}>
                    <th style={{ padding: '6px 8px', fontWeight: 500 }}>
                      {intl.formatMessage({ id: 'pages.monitoring.podHealth.col.pod' })}
                    </th>
                    <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right', width: 120 }}>
                      {intl.formatMessage({ id: 'pages.monitoring.podHealth.col.restarts' })}
                    </th>
                    <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right', width: 120 }}>
                      {intl.formatMessage({ id: 'pages.monitoring.podHealth.col.ooms' })}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(podHealth.data?.rows ?? []).map((r: PodHealthRow) => (
                    <tr
                      key={`${r.namespace}/${r.pod}`}
                      style={{ borderTop: '1px solid var(--ant-color-split)' }}
                    >
                      <td style={{ padding: '6px 8px' }}>
                        <Tag style={{ marginInlineEnd: 6 }}>{r.namespace}</Tag>
                        <span>{r.pod}</span>
                      </td>
                      <td
                        style={{
                          padding: '6px 8px',
                          textAlign: 'right',
                          color: r.restarts > 0 ? 'var(--ant-color-warning)' : undefined,
                          fontWeight: r.restarts > 0 ? 500 : 400,
                        }}
                      >
                        {r.restarts}
                      </td>
                      <td
                        style={{
                          padding: '6px 8px',
                          textAlign: 'right',
                          color: r.ooms > 0 ? 'var(--ant-color-error)' : undefined,
                          fontWeight: r.ooms > 0 ? 500 : 400,
                        }}
                      >
                        {r.ooms}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

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
                    titleId="pages.monitoring.metric.diskIoByNode"
                    unit="MiB/s"
                    unitScale={1 / 1024 / 1024}
                    series={[
                      ...nodeSeries('diskRead').map((s) => ({
                        ...s,
                        name: `${s.name} ↓`,
                      })),
                      ...nodeSeries('diskWrite').map((s) => ({
                        ...s,
                        name: `${s.name} ↑`,
                      })),
                    ]}
                    dark={dark}
                    alwaysShowLegend
                  />
                </Col>
                <Col xs={24} xl={12}>
                  <MultiSeriesChart
                    titleId="pages.monitoring.metric.diskIopsByNode"
                    unit="ops/s"
                    series={[
                      ...nodeSeries('diskReadOps').map((s) => ({
                        ...s,
                        name: `${s.name} ↓`,
                      })),
                      ...nodeSeries('diskWriteOps').map((s) => ({
                        ...s,
                        name: `${s.name} ↑`,
                      })),
                    ]}
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
                <Col xs={24} xl={12}>
                  <MultiSeriesChart
                    titleId="pages.monitoring.metric.loadByNode"
                    unit=""
                    series={nodeSeries('loadPerCore')}
                    dark={dark}
                    alwaysShowLegend
                  />
                </Col>
                <Col xs={24} xl={12}>
                  <MultiSeriesChart
                    titleId="pages.monitoring.metric.netErrorsByNode"
                    unit="errs/s"
                    series={nodeSeries('netErrors')}
                    dark={dark}
                    alwaysShowLegend
                  />
                </Col>
                <Col xs={24} xl={12}>
                  <MultiSeriesChart
                    titleId="pages.monitoring.metric.inodeByNode"
                    unit="%"
                    yMax={100}
                    series={nodeSeries('inodeUtil')}
                    dark={dark}
                    alwaysShowLegend
                  />
                </Col>
                <Col xs={24} xl={12}>
                  <MultiSeriesChart
                    titleId="pages.monitoring.metric.tcpRetransByNode"
                    unit="segs/s"
                    series={nodeSeries('tcpRetrans')}
                    dark={dark}
                    alwaysShowLegend
                  />
                </Col>
              </Row>
            </Suspense>
          </Card>

          {/* Pod-level panels — local namespace picker (deliberately
              not the global one) drives server-side scoping; text
              filter narrows the returned top-N by pod name only. */}
          <Card
            title={intl.formatMessage({ id: 'pages.monitoring.section.pods' })}
            extra={
              <Space>
                <Select
                  size="small"
                  style={{ width: 200 }}
                  allowClear
                  showSearch
                  loading={nsLoading}
                  placeholder={intl.formatMessage({
                    id: 'pages.monitoring.filter.namespace.placeholder',
                  })}
                  value={podNs || undefined}
                  onChange={(v) => setPodNs(v ?? '')}
                  options={nsList.map((n) => ({ label: n, value: n }))}
                  filterOption={(input, opt) =>
                    (opt?.label as string)
                      ?.toLowerCase()
                      .includes(input.trim().toLowerCase())
                  }
                />
                <Input.Search
                  allowClear
                  size="small"
                  style={{ width: 200 }}
                  placeholder={intl.formatMessage({
                    id: 'pages.monitoring.filter.pod.placeholder',
                  })}
                  value={podFilter}
                  onChange={(e) => setPodFilter(e.target.value)}
                />
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
                  <Col xs={24} xl={12}>
                    <MultiSeriesChart
                      titleId="pages.monitoring.metric.netRxByPod"
                      unit="MiB/s"
                      unitScale={1 / 1024 / 1024}
                      titleSuffix={intl.formatMessage({
                        id: 'pages.monitoring.topN',
                      })}
                      series={podSeries('netRx')}
                      dark={dark}
                      alwaysShowLegend
                    />
                  </Col>
                  <Col xs={24} xl={12}>
                    <MultiSeriesChart
                      titleId="pages.monitoring.metric.netTxByPod"
                      unit="MiB/s"
                      unitScale={1 / 1024 / 1024}
                      titleSuffix={intl.formatMessage({
                        id: 'pages.monitoring.topN',
                      })}
                      series={podSeries('netTx')}
                      dark={dark}
                      alwaysShowLegend
                    />
                  </Col>
                  <Col xs={24} xl={12}>
                    <MultiSeriesChart
                      titleId="pages.monitoring.metric.cpuThrottleByPod"
                      unit="%"
                      titleSuffix={intl.formatMessage({
                        id: 'pages.monitoring.topN',
                      })}
                      series={podSeries('cpuThrottle')}
                      dark={dark}
                      alwaysShowLegend
                    />
                  </Col>
                  <Col xs={24} xl={12}>
                    <MultiSeriesChart
                      titleId="pages.monitoring.metric.memLimitRatioByPod"
                      unit="%"
                      titleSuffix={intl.formatMessage({
                        id: 'pages.monitoring.topN',
                      })}
                      series={podSeries('memLimitRatio')}
                      dark={dark}
                      alwaysShowLegend
                    />
                  </Col>
                  <Col xs={24} xl={12}>
                    <MultiSeriesChart
                      titleId="pages.monitoring.metric.fsReadByPod"
                      unit="MiB/s"
                      unitScale={1 / 1024 / 1024}
                      titleSuffix={intl.formatMessage({
                        id: 'pages.monitoring.topN',
                      })}
                      series={podSeries('fsRead')}
                      dark={dark}
                      alwaysShowLegend
                    />
                  </Col>
                  <Col xs={24} xl={12}>
                    <MultiSeriesChart
                      titleId="pages.monitoring.metric.fsWriteByPod"
                      unit="MiB/s"
                      unitScale={1 / 1024 / 1024}
                      titleSuffix={intl.formatMessage({
                        id: 'pages.monitoring.topN',
                      })}
                      series={podSeries('fsWrite')}
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
