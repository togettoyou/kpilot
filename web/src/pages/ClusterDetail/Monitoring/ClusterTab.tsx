import { useIntl } from '@umijs/max';
import {
  Card,
  Col,
  Progress,
  Row,
  Space,
  Statistic,
  Tag,
  theme,
} from 'antd';
import React, { lazy, Suspense, useMemo } from 'react';

import { useClusterRequest } from '@/hooks/useClusterRequest';
import { usageColor } from '@/pages/Compute/Volcano/shared/utils';
import { getClusterMetrics } from '@/services/kpilot/monitoring';

import LazySection, { ChartFallback, usePollingRefresh } from './LazySection';
import { useMonitoringCtx } from './MonitoringContext';

const MultiSeriesChart = lazy(() => import('./MonitoringCharts'));

// ClusterTab — three sections drive the same cluster-metrics endpoint
// but with disjoint ?groups= selectors so each section can refetch
// independently on poll:
//
//   overview  → instant KPIs (cpu / mem / nodes / pods)
//   capacity  → range trends for cpu% / mem% / disk%
//   workload  → pending pods / restart rate / crashlooping trend
//
// All three target the same in-memory cache key on the server (keyed
// by cluster + range + groups signature) — sections that opened the
// same range within 4s share the response body.
const ClusterTab: React.FC = () => {
  const intl = useIntl();
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <LazySection
        tab="cluster"
        title={intl.formatMessage({
          id: 'pages.monitoring.section.cluster.overview',
        })}
        defaultOpen
      >
        {({ active }) => <OverviewBody active={active} />}
      </LazySection>
      <LazySection
        tab="cluster"
        title={intl.formatMessage({
          id: 'pages.monitoring.section.cluster.capacity',
        })}
        defaultOpen
      >
        {({ active }) => <CapacityBody active={active} />}
      </LazySection>
      <LazySection
        tab="cluster"
        title={intl.formatMessage({
          id: 'pages.monitoring.section.cluster.workload',
        })}
        defaultOpen={false}
      >
        {({ active }) => <WorkloadBody active={active} />}
      </LazySection>
    </Space>
  );
};

const OverviewBody: React.FC<{ active: boolean }> = ({ active }) => {
  const intl = useIntl();
  const { clusterId, range } = useMonitoringCtx();
  const { token } = theme.useToken();
  const req = useClusterRequest(
    () => getClusterMetrics(clusterId, range, 'overview'),
    [clusterId, range],
    { ready: !!clusterId },
  );
  usePollingRefresh(req.refresh, active);

  const snap = req.data?.snapshot;
  const phaseEntries = useMemo(
    () => Object.entries(snap?.podsByPhase ?? {}),
    [snap],
  );
  const cpuPct = snap?.cpuUtilPct ?? 0;
  const memPct = snap?.memUtilPct ?? 0;
  const dash = (pct: number) => ({
    fillColor: usageColor(pct / 100, token),
    pct: Math.min(100, Math.max(0, pct)),
  });

  return (
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
  );
};

const CapacityBody: React.FC<{ active: boolean }> = ({ active }) => {
  const intl = useIntl();
  const { clusterId, range, dark } = useMonitoringCtx();
  const req = useClusterRequest(
    () => getClusterMetrics(clusterId, range, 'capacity'),
    [clusterId, range],
    { ready: !!clusterId },
  );
  usePollingRefresh(req.refresh, active);

  const cpuSeries = useMemo(
    () => [
      {
        name: intl.formatMessage({ id: 'pages.monitoring.metric.cpu' }),
        points: req.data?.series?.cpu?.points ?? [],
      },
    ],
    [req.data, intl],
  );
  const memSeries = useMemo(
    () => [
      {
        name: intl.formatMessage({ id: 'pages.monitoring.metric.mem' }),
        points: req.data?.series?.mem?.points ?? [],
      },
    ],
    [req.data, intl],
  );
  const diskSeries = useMemo(
    () => [
      {
        name: intl.formatMessage({ id: 'pages.monitoring.metric.clusterDisk' }),
        points: req.data?.series?.disk?.points ?? [],
      },
    ],
    [req.data, intl],
  );

  return (
    <Suspense fallback={<ChartFallback />}>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.chart.clusterCpu"
            unit="%"
            yMax={100}
            series={cpuSeries}
            dark={dark}
          />
        </Col>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.chart.clusterMem"
            unit="%"
            yMax={100}
            series={memSeries}
            dark={dark}
          />
        </Col>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.clusterDisk"
            unit="%"
            yMax={100}
            series={diskSeries}
            dark={dark}
          />
        </Col>
      </Row>
    </Suspense>
  );
};

const WorkloadBody: React.FC<{ active: boolean }> = ({ active }) => {
  const intl = useIntl();
  const { clusterId, range, dark } = useMonitoringCtx();
  const req = useClusterRequest(
    () => getClusterMetrics(clusterId, range, 'workload'),
    [clusterId, range],
    { ready: !!clusterId },
  );
  usePollingRefresh(req.refresh, active);

  const pendingSeries = useMemo(
    () => [
      {
        name: intl.formatMessage({ id: 'pages.monitoring.metric.pendingPods' }),
        points: req.data?.series?.pendingPods?.points ?? [],
      },
    ],
    [req.data, intl],
  );
  const restartSeries = useMemo(
    () => [
      {
        name: intl.formatMessage({ id: 'pages.monitoring.metric.restartRate' }),
        points: req.data?.series?.restartRate?.points ?? [],
      },
    ],
    [req.data, intl],
  );
  const crashSeries = useMemo(
    () => [
      {
        name: intl.formatMessage({ id: 'pages.monitoring.metric.crashLooping' }),
        points: req.data?.series?.crashLooping?.points ?? [],
      },
    ],
    [req.data, intl],
  );

  return (
    <Suspense fallback={<ChartFallback />}>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.chart.pendingPods"
            unit=""
            series={pendingSeries}
            dark={dark}
          />
        </Col>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.restartRate"
            unit="/s"
            series={restartSeries}
            dark={dark}
          />
        </Col>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.crashLooping"
            unit=""
            series={crashSeries}
            dark={dark}
          />
        </Col>
      </Row>
    </Suspense>
  );
};

interface KPICardProps {
  title: string;
  value: string | number;
  suffix?: React.ReactNode;
  dashPct?: number;
  dashColor?: string;
  bottom?: React.ReactNode;
}

function KPICard({
  title,
  value,
  suffix,
  dashPct,
  dashColor,
  bottom,
}: KPICardProps) {
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

function formatGiB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0';
  const gib = bytes / 1024 / 1024 / 1024;
  if (gib >= 100) return gib.toFixed(0);
  if (gib >= 10) return gib.toFixed(1);
  if (gib >= 1) return gib.toFixed(2);
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

export default ClusterTab;
