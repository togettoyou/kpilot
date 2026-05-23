import { useIntl, useParams } from '@umijs/max';
import {
  Card,
  Col,
  Empty,
  Progress,
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
import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import TimeRangePicker, {
  type TimeRangeValue,
} from '@/components/TimeRangePicker';
import { useClusterRequest } from '@/hooks/useClusterRequest';
import {
  type GPUMetricKey,
  type GPUMetricSeries,
  type GPUMetricsResponse,
  getGPUMetrics,
} from '@/services/kpilot/gpu-metrics';

import {
  isResourceNotAvailable,
  NotInstalled,
  RefreshControl,
  useAutoRefresh,
} from './shared/Layout';
import { usageColor } from './shared/utils';
import type { ThresholdLine } from './GPUMonitoringChart';

const MetricChartCard = lazy(() => import('./GPUMonitoringChart'));

// GPU monitoring — fully self-rendered (no Grafana iframe). Sister to
// /compute/:id/vgpu: that page covers slice allocation, this covers
// hardware-level health (utilization, temperature, power, framebuffer
// memory, SM clock, tensor-core activity).

// Metric definitions used to render the chart grid. `unitScale` is
// applied at point construction time before charting. Order here
// determines panel layout. `thresholds` ship reference lines onto
// the chart so an operator sees overheat / OOM-risk / underuse
// without reading values.
const METRICS: Array<{
  key: GPUMetricKey;
  titleId: string;
  unit: string;
  unitScale?: number;
  yMax?: number;
  thresholdsId?: 'temp' | 'fbUsed' | 'tensor';
}> = [
  { key: 'util', titleId: 'util', unit: '%', yMax: 100 },
  { key: 'temp', titleId: 'temp', unit: '°C', thresholdsId: 'temp' },
  { key: 'power', titleId: 'power', unit: 'W' },
  // FB used in GiB — DCGM ships MiB, divide for the axis.
  {
    key: 'fbUsed',
    titleId: 'fbUsed',
    unit: 'GiB',
    unitScale: 1 / 1024,
    thresholdsId: 'fbUsed',
  },
  { key: 'sm', titleId: 'sm', unit: 'MHz' },
  // Tensor active ships as a unit ratio [0,1]; scale to %.
  {
    key: 'tensor',
    titleId: 'tensor',
    unit: '%',
    unitScale: 100,
    yMax: 100,
    thresholdsId: 'tensor',
  },
];

function dashboardColor(
  pct: number,
  token: { colorSuccess: string; colorWarning: string; colorError: string },
): string {
  return usageColor(pct / 100, token);
}

// gpuKey — stable identifier for a series across charts. (hostname,
// gpu) is the natural unit; UUID would also work but isn't shown in
// the picker. Falls back to UUID-suffix for series missing both.
function gpuKey(s: GPUMetricSeries): string {
  if (s.hostname && s.gpu !== undefined) return `${s.hostname}|${s.gpu}`;
  if (s.hostname) return s.hostname;
  if (s.uuid) return `uuid:${s.uuid}`;
  return '?';
}

function gpuKeyLabel(s: GPUMetricSeries): string {
  const host = s.hostname || s.uuid?.slice(-8) || '?';
  const tail = s.gpu !== undefined ? ` · GPU ${s.gpu}` : '';
  const model = s.modelName ? ` [${s.modelName}]` : '';
  return `${host}${tail}${model}`;
}

// computeFilteredSnapshot — when a filter is applied the
// server-supplied snapshot covers ALL GPUs, so we re-derive a
// snapshot from the filtered series. Mirrors the backend
// computation (last sample per series, averaged across the picked
// GPUs) so the KPI cards reflect the operator's narrowed view.
function computeFilteredSnapshot(
  series: Record<string, GPUMetricSeries[]>,
  picked: Set<string>,
): {
  activeGPUs: number;
  avgUtilPct: number;
  avgTempC: number;
  maxTempC: number;
  totalPowerW: number;
  fbUsedMiB: number;
  fbTotalMiB: number;
  fbUsagePct: number;
  avgTensorActPct: number;
} {
  const lastOf = (s: GPUMetricSeries): number => {
    const p = s.points[s.points.length - 1];
    return p ? p.value : 0;
  };
  const pick = (key: string): GPUMetricSeries[] =>
    (series[key] ?? []).filter((s) => picked.has(gpuKey(s)));
  const util = pick('util');
  const temp = pick('temp');
  const power = pick('power');
  const fbUsed = pick('fbUsed');
  const fbTotal = pick('fbTotal');
  const tensor = pick('tensor');

  const sum = (rows: GPUMetricSeries[]) =>
    rows.reduce((acc, s) => acc + lastOf(s), 0);
  const max = (rows: GPUMetricSeries[]) =>
    rows.reduce((acc, s) => Math.max(acc, lastOf(s)), 0);
  const avg = (rows: GPUMetricSeries[]) =>
    rows.length > 0 ? sum(rows) / rows.length : 0;

  const fbUsedM = sum(fbUsed);
  const fbTotalM = sum(fbTotal);
  return {
    activeGPUs: util.length,
    avgUtilPct: avg(util),
    avgTempC: avg(temp),
    maxTempC: max(temp),
    totalPowerW: sum(power),
    fbUsedMiB: fbUsedM,
    fbTotalMiB: fbTotalM,
    fbUsagePct: fbTotalM > 0 ? (fbUsedM / fbTotalM) * 100 : 0,
    avgTensorActPct: avg(tensor) * 100, // tensor stored as ratio
  };
}

// computeAttention — single-pass scan of the filtered series to
// surface the three GPU classes an operator most often wants to
// look at first:
//   - idle:        util series flat at 0 for the last >=10 samples
//                  → wasted capacity
//   - hot:         current temp >= 85°C → cooling / power limits
//   - oomRisk:     FB usage >= 95% → app about to OOM
// Frontend-derived (no backend dependency) so it stays cheap.
function computeAttention(
  series: Record<string, GPUMetricSeries[]>,
  picked: Set<string>,
): { idle: string[]; hot: string[]; oomRisk: string[] } {
  const inSet = (s: GPUMetricSeries) => picked.has(gpuKey(s));
  const last = (s: GPUMetricSeries) =>
    s.points.length > 0 ? s.points[s.points.length - 1].value : 0;

  const idle: string[] = [];
  for (const s of (series.util ?? []).filter(inSet)) {
    const pts = s.points.slice(-10);
    if (pts.length >= 5 && pts.every((p) => p.value === 0)) {
      idle.push(gpuKeyLabel(s));
    }
  }
  const hot = (series.temp ?? [])
    .filter((s) => inSet(s) && last(s) >= 85)
    .map(gpuKeyLabel);

  // OOM risk needs the per-GPU FB% — join fbUsed × fbTotal by gpuKey.
  const fbTotalByKey = new Map<string, number>();
  for (const s of (series.fbTotal ?? []).filter(inSet)) {
    fbTotalByKey.set(gpuKey(s), last(s));
  }
  const oomRisk: string[] = [];
  for (const s of (series.fbUsed ?? []).filter(inSet)) {
    const total = fbTotalByKey.get(gpuKey(s)) ?? 0;
    if (total > 0 && (last(s) / total) * 100 >= 95) {
      oomRisk.push(gpuKeyLabel(s));
    }
  }
  return { idle, hot, oomRisk };
}

// THRESHOLDS — chart annotation defaults. Keys match METRICS.thresholdsId.
const THRESHOLDS: Record<string, ThresholdLine[]> = {
  temp: [
    { value: 80, kind: 'warn', label: '80°C' },
    { value: 90, kind: 'error', label: '90°C' },
  ],
  fbUsed: [
    // No fixed unit value works for fbUsed (GiB varies by card),
    // but the chart already auto-scales — annotate at "90% of
    // typical 40 GiB card" as a soft hint. Operators with H100
    // (80 GiB) get a more cautious line; with T4 (16 GiB) it's
    // pessimistic but informative.
    { value: 36, kind: 'warn', label: '90% (40G)' },
  ],
  tensor: [
    { value: 5, kind: 'info', label: '5% (idle)' },
  ],
};

const GPUMonitoringPage: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId = '' } = useParams<{ id: string }>();
  const { appearance } = useThemeMode();
  const dark = appearance === 'dark';
  const { token } = theme.useToken();

  const [range, setRange] = useState<TimeRangeValue>({
    mode: 'preset',
    preset: '1h',
  });

  // Page-switch scroll reset — same fix as logging / chat page.
  // GPU monitoring is a long scrollable page; if user came from
  // another scrolled page the inherited scrollTop puts the wrapper
  // out of view.
  const pageRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    window.scrollTo(0, 0);
    const reset = () => {
      let el: HTMLElement | null = pageRef.current;
      while (el && el !== document.body) {
        if (el.scrollTop) el.scrollTop = 0;
        el = el.parentElement;
      }
    };
    if (pageRef.current) reset();
    else requestAnimationFrame(reset);
  }, []);

  const { data, loading, error, refresh } = useClusterRequest(
    () => getGPUMetrics(clusterId, range),
    [clusterId, range],
    { ready: !!clusterId },
  );

  const [interval, setInter] = useAutoRefresh(refresh, !!data);

  // Filter state — multi-select of gpuKey strings. Empty array = "all".
  const [picked, setPicked] = useState<string[]>([]);

  // Enumerate all (hostname, gpu) combos from any series — `util` is
  // safest (DCGM reports util for every device), but fall back to any
  // available series in case a brand-new cluster's util feed is still
  // warming up.
  const allKeys = useMemo(() => {
    const out: { key: string; label: string }[] = [];
    const seen = new Set<string>();
    const collect = (rows: GPUMetricSeries[] | undefined) => {
      for (const s of rows ?? []) {
        const k = gpuKey(s);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ key: k, label: gpuKeyLabel(s) });
      }
    };
    collect(data?.series?.util);
    collect(data?.series?.temp);
    collect(data?.series?.power);
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [data]);

  // Active filter set — empty picked → all, otherwise as selected.
  const activeSet = useMemo(() => {
    if (picked.length === 0) return new Set(allKeys.map((k) => k.key));
    return new Set(picked);
  }, [picked, allKeys]);

  // Re-projected series with filter applied; everything downstream
  // (charts, snapshot, attention list) reads from this.
  const filteredSeries = useMemo<Record<string, GPUMetricSeries[]>>(() => {
    const raw = (data?.series ?? {}) as Record<string, GPUMetricSeries[]>;
    const out: Record<string, GPUMetricSeries[]> = {};
    for (const k of Object.keys(raw)) {
      out[k] = (raw[k] ?? []).filter((s: GPUMetricSeries) =>
        activeSet.has(gpuKey(s)),
      );
    }
    return out;
  }, [data, activeSet]);

  // Use the server snapshot when no filter is in effect (cheaper +
  // more accurate over the full window). Otherwise derive locally.
  const snap = useMemo(() => {
    if (!data) return undefined;
    if (picked.length === 0) return data.snapshot;
    return computeFilteredSnapshot(filteredSeries, activeSet);
  }, [data, filteredSeries, activeSet, picked.length]);

  const attention = useMemo(
    () => (data ? computeAttention(filteredSeries, activeSet) : null),
    [data, filteredSeries, activeSet],
  );

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

  const series = filteredSeries;
  const noData =
    !!data &&
    Object.values(series).every(
      (rows) =>
        !rows || rows.length === 0 || rows.every((r) => r.points.length === 0),
    );

  return (
    <div className="p-6" ref={pageRef}>
      <Spin spinning={loading && !data}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Card size="small" styles={{ body: { padding: '8px 12px' } }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <TimeRangePicker value={range} onChange={setRange} />
              <Select
                size="small"
                mode="multiple"
                allowClear
                showSearch
                placeholder={intl.formatMessage({
                  id: 'pages.gpuMonitoring.filter.placeholder',
                })}
                style={{ minWidth: 260, maxWidth: 520 }}
                value={picked}
                onChange={setPicked}
                options={allKeys.map((k) => ({
                  label: k.label,
                  value: k.key,
                }))}
                maxTagCount="responsive"
                filterOption={(input, opt) =>
                  (opt?.label as string)
                    ?.toLowerCase()
                    .includes(input.trim().toLowerCase())
                }
              />
              <div style={{ flex: 1 }} />
              <RefreshControl
                interval={interval}
                setInterval={setInter}
                loading={loading}
                refresh={refresh}
              />
            </div>
          </Card>

          {/* KPI row — six cards, snapshot-derived. When a filter is
              applied the snapshot is computed client-side from the
              filtered series so the cards always match the charts. */}
          <Row gutter={[16, 16]} align="stretch">
            <Col xs={24} sm={12} md={12} lg={8} xl={6} xxl={4}>
              <Card style={{ height: '100%' }}>
                <KpiTile
                  title={intl.formatMessage({
                    id: 'pages.gpuMonitoring.snap.activeGPUs',
                  })}
                  value={snap?.activeGPUs ?? 0}
                />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={12} lg={8} xl={6} xxl={4}>
              <Card style={{ height: '100%' }}>
                <KpiTile
                  title={intl.formatMessage({
                    id: 'pages.gpuMonitoring.snap.avgUtil',
                  })}
                  value={snap?.avgUtilPct ?? 0}
                  precision={1}
                  suffix="%"
                  dashboard={
                    <Progress
                      type="dashboard"
                      percent={Math.min(snap?.avgUtilPct ?? 0, 100)}
                      size={56}
                      strokeColor={dashboardColor(snap?.avgUtilPct ?? 0, token)}
                      format={() => ''}
                    />
                  }
                />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={12} lg={8} xl={6} xxl={4}>
              <Card style={{ height: '100%' }}>
                <KpiTile
                  title={intl.formatMessage({
                    id: 'pages.gpuMonitoring.snap.fbUsage',
                  })}
                  value={snap?.fbUsagePct ?? 0}
                  precision={1}
                  suffix="%"
                  dashboard={
                    <Progress
                      type="dashboard"
                      percent={Math.min(snap?.fbUsagePct ?? 0, 100)}
                      size={56}
                      strokeColor={dashboardColor(snap?.fbUsagePct ?? 0, token)}
                      format={() => {
                        const used = ((snap?.fbUsedMiB ?? 0) / 1024).toFixed(0);
                        const total = ((snap?.fbTotalMiB ?? 0) / 1024).toFixed(0);
                        return `${used}/${total}G`;
                      }}
                    />
                  }
                />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={12} lg={8} xl={6} xxl={4}>
              <Card style={{ height: '100%' }}>
                <KpiTile
                  title={intl.formatMessage({
                    id: 'pages.gpuMonitoring.snap.avgTemp',
                  })}
                  value={snap?.avgTempC ?? 0}
                  precision={1}
                  suffix="°C"
                  dashboard={
                    <Progress
                      type="dashboard"
                      percent={Math.min(
                        ((snap?.avgTempC ?? 0) / 90) * 100,
                        100,
                      )}
                      size={56}
                      strokeColor={dashboardColor(
                        ((snap?.avgTempC ?? 0) / 90) * 100,
                        token,
                      )}
                      format={() => `↑${(snap?.maxTempC ?? 0).toFixed(0)}`}
                    />
                  }
                />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={12} lg={8} xl={6} xxl={4}>
              <Card style={{ height: '100%' }}>
                <KpiTile
                  title={intl.formatMessage({
                    id: 'pages.gpuMonitoring.snap.totalPower',
                  })}
                  value={snap?.totalPowerW ?? 0}
                  precision={0}
                  suffix="W"
                />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={12} lg={8} xl={6} xxl={4}>
              <Card style={{ height: '100%' }}>
                <KpiTile
                  title={intl.formatMessage({
                    id: 'pages.gpuMonitoring.snap.tensor',
                  })}
                  value={snap?.avgTensorActPct ?? 0}
                  precision={1}
                  suffix="%"
                  dashboard={
                    <Progress
                      type="dashboard"
                      percent={Math.min(snap?.avgTensorActPct ?? 0, 100)}
                      size={56}
                      strokeColor={dashboardColor(
                        snap?.avgTensorActPct ?? 0,
                        token,
                      )}
                      format={() => ''}
                    />
                  }
                />
              </Card>
            </Col>
          </Row>

          {/* Attention list — only render when at least one bucket is
              populated. Healthy clusters skip the card entirely so
              it doesn't waste vertical space. */}
          {attention &&
            (attention.idle.length > 0 ||
              attention.hot.length > 0 ||
              attention.oomRisk.length > 0) && (
              <Card
                size="small"
                title={intl.formatMessage({
                  id: 'pages.gpuMonitoring.attention.title',
                })}
                styles={{ body: { padding: 12 } }}
              >
                <Row gutter={[16, 12]}>
                  <AttentionCol
                    color="blue"
                    label={intl.formatMessage({
                      id: 'pages.gpuMonitoring.attention.idle',
                    })}
                    items={attention.idle}
                  />
                  <AttentionCol
                    color="orange"
                    label={intl.formatMessage({
                      id: 'pages.gpuMonitoring.attention.hot',
                    })}
                    items={attention.hot}
                  />
                  <AttentionCol
                    color="red"
                    label={intl.formatMessage({
                      id: 'pages.gpuMonitoring.attention.oomRisk',
                    })}
                    items={attention.oomRisk}
                  />
                </Row>
              </Card>
            )}

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
                      thresholds={
                        m.thresholdsId ? THRESHOLDS[m.thresholdsId] : undefined
                      }
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

function KpiTile({
  title,
  value,
  precision,
  suffix,
  dashboard,
}: {
  title: string;
  value: number;
  precision?: number;
  suffix?: string;
  dashboard?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <Statistic
          title={<span style={{ whiteSpace: 'nowrap' }}>{title}</span>}
          value={value}
          precision={precision}
          suffix={suffix}
          valueStyle={{ whiteSpace: 'nowrap' }}
        />
      </div>
      {dashboard && <div style={{ flexShrink: 0 }}>{dashboard}</div>}
    </div>
  );
}

const AttentionCol: React.FC<{
  color: 'red' | 'orange' | 'blue';
  label: string;
  items: string[];
}> = ({ color, label, items }) => (
  <Col xs={24} sm={8}>
    <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)', marginBottom: 6 }}>
      {label} · {items.length}
    </div>
    {items.length === 0 ? (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        —
      </Typography.Text>
    ) : (
      <Space size={4} wrap>
        {items.map((it) => (
          <Tag key={it} color={color} style={{ marginInlineEnd: 0 }}>
            {it}
          </Tag>
        ))}
      </Space>
    )}
  </Col>
);

export default GPUMonitoringPage;
