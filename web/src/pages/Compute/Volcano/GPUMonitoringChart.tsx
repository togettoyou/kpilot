import {
  FullscreenExitOutlined,
  FullscreenOutlined,
} from '@ant-design/icons';
import { Line } from '@ant-design/plots';
import { useIntl } from '@umijs/max';
import { Button, Card, Empty, Space, Tooltip, Typography } from 'antd';
import React, { useEffect, useRef, useState } from 'react';

import type { GPUMetricSeries } from '@/services/kpilot/gpu-metrics';

// MetricChartCard is split into its own module so the @ant-design/plots
// G2 runtime (~250 KB gzip) is only fetched when the GPU monitoring
// page is actually opened. Pages that don't need it (every other page
// in /compute) skip the bundle entirely. The main GPUMonitoring page
// imports this via React.lazy + Suspense.

interface FlatPoint {
  t: number;
  v: number;
  series: string;
}

// ThresholdLine — annotation drawn across the plot at a fixed y value.
// Use for capacity / overheat / under-utilisation thresholds so the
// operator sees "this point is over the line" before reading numbers.
export interface ThresholdLine {
  value: number;
  // Visual style. `kind` decides which theme token drives the colour
  // so dark/light parity is automatic. `label` annotates the line in
  // the chart's right margin.
  kind: 'warn' | 'error' | 'info';
  label?: string;
}

interface MetricChartCardProps {
  titleId: string;
  unit: string;
  yMax?: number;
  unitScale?: number;
  seriesRows: GPUMetricSeries[];
  dark: boolean;
  // Optional reference lines drawn across the plot. Empty = no
  // annotations.
  thresholds?: ThresholdLine[];
}

function MetricChartCard({
  titleId,
  unit,
  yMax,
  unitScale,
  seriesRows,
  dark,
  thresholds,
}: MetricChartCardProps) {
  const intl = useIntl();

  const flat: FlatPoint[] = React.useMemo(() => {
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

  // Tab-switch / hidden-pane layout guard, same as MonitoringCharts.
  // When the chart is mounted with display:none ancestors, G2 measures
  // its container at width 0 and the resulting layout doesn't recover
  // when the container later becomes visible. Gate on a measured-
  // visible wrapper so the Line component mounts / remounts in the
  // correct size.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [chartReady, setChartReady] = useState(true);
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setChartReady(w > 0);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fullscreen mode — the chart card escapes its grid cell and fills
  // the viewport so an operator can read a noisy multi-GPU trend
  // without squinting. Esc exits.
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

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

  // G2 annotations payload — one lineY annotation per ThresholdLine.
  // Colours via inline rgba so we don't need to read antd tokens here
  // (tokens are already-resolved by the Card border anyway).
  const annotations = (thresholds ?? []).map((th) => {
    const color =
      th.kind === 'error'
        ? '#ff4d4f'
        : th.kind === 'warn'
          ? '#faad14'
          : '#1677ff';
    return {
      type: 'lineY' as const,
      data: [th.value],
      style: {
        stroke: color,
        strokeWidth: 1,
        strokeOpacity: 0.7,
        lineDash: [4, 4],
      },
      labels: th.label
        ? [
            {
              text: th.label,
              position: 'right',
              fill: color,
              fontSize: 11,
              dy: -4,
            },
          ]
        : undefined,
    };
  });

  // Dynamic sizing — when fullscreen, the chart fills the viewport
  // minus a small header strip; otherwise the cell-default 220.
  const plotHeight = fullscreen ? Math.max(360, window.innerHeight - 140) : 220;
  const title = (
    <Space>
      <Typography.Text strong>
        {intl.formatMessage({ id: titleId })}
      </Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        ({unit})
      </Typography.Text>
    </Space>
  );
  const fullscreenButton = (
    <Tooltip
      title={intl.formatMessage({
        id: fullscreen
          ? 'pages.gpuMonitoring.chart.exitFullscreen'
          : 'pages.gpuMonitoring.chart.enterFullscreen',
      })}
    >
      <Button
        size="small"
        type="text"
        icon={
          fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />
        }
        onClick={() => setFullscreen((v) => !v)}
      />
    </Tooltip>
  );
  const card = (
    <Card
      title={title}
      extra={fullscreenButton}
      size="small"
      styles={{ body: { padding: 16 } }}
      style={fullscreen ? { width: '100%' } : undefined}
    >
      <div
        ref={wrapperRef}
        style={{ height: plotHeight, overflow: 'hidden' }}
      >
        {chartReady && (
          <Line
            data={flat}
            xField="t"
            yField="v"
            colorField="series"
            axis={{
              x: {
                labelFormatter: (val: any) => {
                  const d = new Date(
                    typeof val === 'number' ? val : Number(val),
                  );
                  if (Number.isNaN(d.getTime())) return '';
                  const hh = String(d.getHours()).padStart(2, '0');
                  const mm = String(d.getMinutes()).padStart(2, '0');
                  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
                },
              },
              y: { labelFormatter: (v: any) => fmtAxis(v) },
            }}
            scale={{
              y: yMax ? { domainMin: 0, domainMax: yMax } : { domainMin: 0 },
            }}
            legend={{ color: { itemMarker: 'circle' } }}
            tooltip={{
              title: (datum: any) => {
                const d = new Date(datum.t);
                return d.toLocaleString();
              },
              items: [
                {
                  field: 'v',
                  valueFormatter: (v: any) => `${fmtAxis(v)} ${unit}`,
                },
              ],
            }}
            // Threshold reference lines (warn / error / info).
            // Empty array = no annotations rendered.
            annotations={annotations}
            theme={dark ? 'classicDark' : 'classic'}
            interaction={{ tooltip: { shared: true } }}
            style={{ lineWidth: 1.5 }}
          />
        )}
      </div>
    </Card>
  );
  if (!fullscreen) return card;
  // Portal-style overlay: position:fixed over the viewport, dark
  // backdrop click to exit. Card is centered with auto margins.
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        background: 'rgba(0, 0, 0, 0.45)',
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
      }}
      onClick={(e) => {
        // Click the backdrop (not the card) → exit fullscreen.
        if (e.target === e.currentTarget) setFullscreen(false);
      }}
    >
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>{card}</div>
    </div>
  );
}

function seriesLabel(row: GPUMetricSeries): string {
  const host = row.hostname || row.uuid?.slice(-8) || '?';
  // Model name (DCGM_FI_DEV_NAME label, when backend ships it) sits
  // in brackets after the host so operators can tell heterogenous
  // GPUs apart at a glance.
  const tail = row.gpu ? ` · GPU ${row.gpu}` : '';
  const model = row.modelName ? ` [${row.modelName}]` : '';
  return `${host}${tail}${model}`;
}

function fmtAxis(v: any): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(1);
  return n.toFixed(2);
}

export default MetricChartCard;
