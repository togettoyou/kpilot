import { useIntl, useParams } from '@umijs/max';

import { useClusterRequest } from '@/hooks/useClusterRequest';
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
  theme,
  Typography,
} from 'antd';
import { useThemeMode } from 'antd-style';
import React, { lazy, Suspense, useMemo, useState } from 'react';

import {
  getGPUMetrics,
  type GPUMetricKey,
  type GPUMetricsRange,
} from '@/services/kpilot/gpu-metrics';

import {
  NotInstalled,
  RefreshControl,
  isResourceNotAvailable,
  useAutoRefresh,
} from './shared/Layout';
import { usageColor } from './shared/utils';

// MetricChartCard pulls in @ant-design/plots (~250 KB gzip G2 runtime).
// Lazy-load so opening any other /compute page doesn't pay for charts
// only this one renders.
const MetricChartCard = lazy(() => import('./GPUMonitoringChart'));

// GPU monitoring — fully self-rendered (no Grafana iframe). Sister to
// /compute/:id/vgpu: that page covers slice allocation; this covers
// hardware-level health (utilization, temperature, power, framebuffer
// memory, SM clock, tensor-core activity). The 算力调度 platform is
// kept specialized — Grafana stays as the generic dashboard tool for
// cluster management.
//
// Data: server pre-aggregates six DCGM range queries + a "current
// snapshot" in /clusters/:id/gpu-metrics?range=…. The page slices the
// response into one Line chart per metric plus four KPI gauges.

const RANGES: GPUMetricsRange[] = ['1h', '24h', '7d', '30d'];

// Metric definitions used to render the chart grid. `unitScale` is
// applied at point construction time before charting (e.g. MiB → GiB,
// unit ratio → %). Order here determines panel layout.
const METRICS: Array<{
  key: GPUMetricKey;
  // i18n suffix under pages.gpuMonitoring.metric.<key>
  titleId: string;
  unit: string;
  unitScale?: number;
  // Optional fixed max for the chart's Y axis; otherwise auto-fit.
  yMax?: number;
}> = [
  { key: 'util', titleId: 'util', unit: '%', yMax: 100 },
  { key: 'temp', titleId: 'temp', unit: '°C' },
  { key: 'power', titleId: 'power', unit: 'W' },
  // FB used in GiB — DCGM ships MiB, divide for the axis.
  { key: 'fbUsed', titleId: 'fbUsed', unit: 'GiB', unitScale: 1 / 1024 },
  { key: 'sm', titleId: 'sm', unit: 'MHz' },
  // Tensor active ships as a unit ratio [0,1]; scale to %.
  { key: 'tensor', titleId: 'tensor', unit: '%', unitScale: 100, yMax: 100 },
];

// dashboardColor picks the Progress gauge color band, expressed in
// antd theme tokens so the result tracks dark/light mode. The
// shared usageColor helper takes a [0,1] ratio; we receive [0,100]
// percent here so divide by 100 inside.
function dashboardColor(
  pct: number,
  token: { colorSuccess: string; colorWarning: string; colorError: string },
): string {
  return usageColor(pct / 100, token);
}

const GPUMonitoringPage: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId = '' } = useParams<{ id: string }>();
  const { appearance } = useThemeMode();
  const dark = appearance === 'dark';
  const { token } = theme.useToken();

  const [range, setRange] = useState<GPUMetricsRange>('1h');

  const { data, loading, error, refresh } = useClusterRequest(
    () => getGPUMetrics(clusterId, range),
    [clusterId, range],
    { ready: !!clusterId },
  );

  const [interval, setInter] = useAutoRefresh(refresh, !!data);

  if (error && isResourceNotAvailable(error)) {
    return (
      <NotInstalled
        clusterId={clusterId}
        titleId="pages.gpuMonitoring.notInstalled.title"
        subTitleId="pages.gpuMonitoring.notInstalled.subTitle"
        actionId="pages.gpuMonitoring.notInstalled.action"
      />
    );
  }
  if (error) {
    return (
      <Result
        status="error"
        title={intl.formatMessage({ id: 'pages.gpuMonitoring.error.title' })}
        subTitle={(error as Error).message}
      />
    );
  }

  const snap = data?.snapshot;
  const series = data?.series ?? {};
  const noData =
    !!data &&
    Object.values(series).every(
      (rows) => !rows || rows.length === 0 || rows.every((r) => r.points.length === 0),
    );

  return (
    <div className="p-6">
      <Spin spinning={loading && !data}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {/* In-page toolbar — range picker + refresh, matching the
             no-breadcrumb / no-page-title convention the rest of the
             Compute platform uses. */}
          <Card size="small" styles={{ body: { padding: '8px 12px' } }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <Radio.Group
                value={range}
                onChange={(e) => setRange(e.target.value)}
                optionType="button"
                buttonStyle="solid"
                options={RANGES.map((r) => ({ label: r, value: r }))}
              />
              <RefreshControl
                interval={interval}
                setInterval={setInter}
                loading={loading}
                refresh={refresh}
              />
            </div>
          </Card>
          {/* KPI row — snapshot is computed server-side from the last
             range point per series. activeGPUs comes from util series
             cardinality (utilization reports even for idle GPUs). */}
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12} md={6}>
              <Card>
                <Statistic
                  title={intl.formatMessage({
                    id: 'pages.gpuMonitoring.snap.activeGPUs',
                  })}
                  value={snap?.activeGPUs ?? 0}
                />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Card>
                <div className="flex items-center justify-between">
                  <Statistic
                    title={intl.formatMessage({
                      id: 'pages.gpuMonitoring.snap.avgUtil',
                    })}
                    value={snap?.avgUtilPct ?? 0}
                    precision={1}
                    suffix="%"
                  />
                  <Progress
                    type="dashboard"
                    percent={Math.min(snap?.avgUtilPct ?? 0, 100)}
                    size={64}
                    strokeColor={dashboardColor(snap?.avgUtilPct ?? 0, token)}
                    format={() => ''}
                  />
                </div>
              </Card>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Card>
                <div className="flex items-center justify-between">
                  <Statistic
                    title={intl.formatMessage({
                      id: 'pages.gpuMonitoring.snap.avgTemp',
                    })}
                    value={snap?.avgTempC ?? 0}
                    precision={1}
                    suffix="°C"
                  />
                  <Progress
                    type="dashboard"
                    // Soft scale: 60°C → 50%, 90°C → 100% so the dial
                    // saturates at the bundled overheat threshold.
                    percent={Math.min(((snap?.avgTempC ?? 0) / 90) * 100, 100)}
                    size={64}
                    strokeColor={dashboardColor(((snap?.avgTempC ?? 0) / 90) * 100, token)}
                    format={() => `↑${(snap?.maxTempC ?? 0).toFixed(0)}`}
                  />
                </div>
              </Card>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Card>
                <div className="flex items-center justify-between">
                  <Statistic
                    title={intl.formatMessage({
                      id: 'pages.gpuMonitoring.snap.totalPower',
                    })}
                    value={snap?.totalPowerW ?? 0}
                    precision={0}
                    suffix="W"
                  />
                  <Statistic
                    title={intl.formatMessage({
                      id: 'pages.gpuMonitoring.snap.fbUsage',
                    })}
                    value={snap?.fbUsagePct ?? 0}
                    precision={1}
                    suffix="%"
                    valueStyle={{ fontSize: 14 }}
                  />
                </div>
              </Card>
            </Col>
          </Row>

          {noData ? (
            <Card>
              <Empty
                description={intl.formatMessage({
                  id: 'pages.gpuMonitoring.empty',
                })}
              />
            </Card>
          ) : (
            <Suspense
              fallback={
                <div style={{ textAlign: 'center', padding: 64 }}>
                  <Spin />
                </div>
              }
            >
              <Row gutter={[16, 16]}>
                {METRICS.map((m) => (
                  <Col xs={24} xl={12} key={m.key}>
                    <MetricChartCard
                      titleId={`pages.gpuMonitoring.metric.${m.titleId}`}
                      unit={m.unit}
                      yMax={m.yMax}
                      unitScale={m.unitScale}
                      seriesRows={series[m.key] ?? []}
                      dark={dark}
                    />
                  </Col>
                ))}
              </Row>
            </Suspense>
          )}
        </Space>
      </Spin>
    </div>
  );
};

export default GPUMonitoringPage;
