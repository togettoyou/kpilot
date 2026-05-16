import { Line } from '@ant-design/plots';
import { PageContainer } from '@ant-design/pro-components';
import { useIntl, useParams, useRequest } from '@umijs/max';
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
  Typography,
} from 'antd';
import { useThemeMode } from 'antd-style';
import React, { useMemo, useState } from 'react';

import {
  getGPUMetrics,
  type GPUMetricKey,
  type GPUMetricSeries,
  type GPUMetricsRange,
} from '@/services/kpilot/gpu-metrics';

import {
  NotInstalled,
  RefreshControl,
  isResourceNotAvailable,
  useAutoRefresh,
} from './shared/Layout';

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

// FlatPoint = one chart datum. The Line plot wants (x, y, series) tuples;
// we project from the server's per-series structure once and memoize.
interface FlatPoint {
  t: number;
  v: number;
  series: string;
}

// dashboardColor picks the Progress gauge color band. Same thresholds
// the vGPU page uses for slot / mem / core utilization so the platform
// feels consistent — high = red, mid = yellow, otherwise green.
function dashboardColor(pct: number): string {
  if (pct >= 85) return '#ff4d4f';
  if (pct >= 60) return '#faad14';
  return '#52c41a';
}

const GPUMonitoringPage: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId = '' } = useParams<{ id: string }>();
  const { appearance } = useThemeMode();
  const dark = appearance === 'dark';

  const [range, setRange] = useState<GPUMetricsRange>('1h');

  const { data, loading, error, refresh } = useRequest(
    () => getGPUMetrics(clusterId, range),
    {
      formatResult: (res) => res,
      refreshDeps: [clusterId, range],
      ready: !!clusterId,
    },
  );

  const [interval, setInter] = useAutoRefresh(refresh, !!data);

  if (error && isResourceNotAvailable(error)) {
    return (
      <PageContainer ghost>
        <NotInstalled
          clusterId={clusterId}
          titleId="pages.gpuMonitoring.notInstalled.title"
          subTitleId="pages.gpuMonitoring.notInstalled.subTitle"
          actionId="pages.gpuMonitoring.notInstalled.action"
        />
      </PageContainer>
    );
  }
  if (error) {
    return (
      <PageContainer ghost>
        <Result
          status="error"
          title={intl.formatMessage({ id: 'pages.gpuMonitoring.error.title' })}
          subTitle={(error as Error).message}
        />
      </PageContainer>
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
    <PageContainer
      ghost
      header={{
        title: intl.formatMessage({ id: 'pages.gpuMonitoring.title' }),
        extra: (
          <Space>
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
          </Space>
        ),
      }}
    >
      <Spin spinning={loading && !data}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
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
                    strokeColor={dashboardColor(snap?.avgUtilPct ?? 0)}
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
                    strokeColor={dashboardColor(((snap?.avgTempC ?? 0) / 90) * 100)}
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
          )}
        </Space>
      </Spin>
    </PageContainer>
  );
};

export default GPUMonitoringPage;

// MetricChartCard renders one metric's series as a multi-line chart.
// Each series gets a legend entry "<hostname> · GPU <gpu>" (or just
// hostname if GPU index is missing — DCGM Exporter occasionally omits
// the gpu label when scraping under MIG mode).
function MetricChartCard({
  titleId,
  unit,
  yMax,
  unitScale,
  seriesRows,
  dark,
}: {
  titleId: string;
  unit: string;
  yMax?: number;
  unitScale?: number;
  seriesRows: GPUMetricSeries[];
  dark: boolean;
}) {
  const intl = useIntl();

  const flat: FlatPoint[] = useMemo(() => {
    const scale = unitScale ?? 1;
    const out: FlatPoint[] = [];
    for (const row of seriesRows) {
      const label = seriesLabel(row);
      for (const p of row.points) {
        out.push({ t: p.ts, v: p.value * scale, series: label });
      }
    }
    return out;
  }, [seriesRows, unitScale]);

  if (flat.length === 0) {
    return (
      <Card
        title={intl.formatMessage({ id: titleId })}
        size="small"
        styles={{ body: { padding: 16 } }}
      >
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={intl.formatMessage({
            id: 'pages.gpuMonitoring.chartEmpty',
          })}
        />
      </Card>
    );
  }

  return (
    <Card
      title={
        <Space>
          <Typography.Text strong>
            {intl.formatMessage({ id: titleId })}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            ({unit})
          </Typography.Text>
        </Space>
      }
      size="small"
      styles={{ body: { padding: 16 } }}
    >
      <div style={{ height: 220 }}>
        <Line
          data={flat}
          xField="t"
          yField="v"
          colorField="series"
          // Time axis: tick label format depends on the range. For
          // ranges shorter than a day show HH:MM, otherwise show
          // M/D HH:MM. Plot inspects the raw ms value (cast to Date)
          // and formats inline.
          axis={{
            x: {
              labelFormatter: (val: any) => {
                const d = new Date(typeof val === 'number' ? val : Number(val));
                if (Number.isNaN(d.getTime())) return '';
                const hh = String(d.getHours()).padStart(2, '0');
                const mm = String(d.getMinutes()).padStart(2, '0');
                return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
              },
            },
            y: { labelFormatter: (v: any) => fmtAxis(v) },
          }}
          scale={{ y: yMax ? { domainMin: 0, domainMax: yMax } : { domainMin: 0 } }}
          legend={{ color: { itemMarker: 'circle' } }}
          tooltip={{
            title: (datum: any) => {
              const d = new Date(datum.t);
              return d.toLocaleString();
            },
            items: [
              {
                channel: 'y',
                valueFormatter: (v: any) => `${fmtAxis(v)} ${unit}`,
              },
            ],
          }}
          theme={dark ? 'classicDark' : 'classic'}
          interaction={{ tooltip: { shared: true } }}
          style={{ lineWidth: 1.5 }}
        />
      </div>
    </Card>
  );
}

function seriesLabel(row: GPUMetricSeries): string {
  const host = row.hostname || row.uuid?.slice(-8) || '?';
  return row.gpu ? `${host} · GPU ${row.gpu}` : host;
}

function fmtAxis(v: any): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(1);
  return n.toFixed(2);
}
