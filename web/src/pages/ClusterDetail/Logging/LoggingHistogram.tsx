import { Column } from '@ant-design/plots';
import { useIntl } from '@umijs/max';
import { Empty } from 'antd';
import React, { useMemo } from 'react';

import type { LogsHistogramPoint } from '@/services/kpilot/logs';

// Histogram chart for the Logging page. Same lazy-load pattern as
// MonitoringCharts — the @ant-design/plots G2 runtime only ships when
// this component renders.
//
// Click-to-zoom: click a bar to narrow the query's time window to
// that bin. Parent receives the [from, to] range via onZoom and
// updates the page's time-range picker (custom mode) + re-runs the
// query. Bin width comes from stepSeconds (server-computed for
// ~50-bucket charts), so the new range matches exactly one bar.

interface LoggingHistogramProps {
  points: LogsHistogramPoint[];
  dark: boolean;
  height?: number;
  // stepSeconds is the histogram bin width. Required for the
  // click-to-zoom flow — without it we can't derive `to` from the
  // clicked bar's `t`. Comes from logsHistogram() response.
  stepSeconds: number;
  // onZoom fires when the user clicks a bar. from/to are Date.
  // Optional — if absent, clicks are no-op (back-compat with any
  // caller that doesn't wire zoom).
  onZoom?: (from: Date, to: Date) => void;
}

function LoggingHistogram({
  points,
  dark,
  height = 140,
  stepSeconds,
  onZoom,
}: LoggingHistogramProps) {
  const intl = useIntl();
  const data = useMemo(
    () => points.map((p) => ({ t: p.ts, count: p.count })),
    [points],
  );

  if (data.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={intl.formatMessage({ id: 'pages.logging.histogram.empty' })}
        style={{ padding: 24 }}
      />
    );
  }

  return (
    <div style={{ height }}>
      <Column
        data={data}
        xField="t"
        yField="count"
        // onReady gives us the underlying Chart instance; we attach a
        // bar-click listener that finds the originating datum and
        // hands its bin range out to the parent. We can't use a
        // React-level onClick because G2 v5 doesn't expose one.
        onReady={(chartInstance: any) => {
          if (!onZoom) return;
          const chart = chartInstance?.chart ?? chartInstance;
          if (!chart?.on) return;
          chart.on('interval:click', (evt: any) => {
            // G2 hands the datum on evt.data.data — the original
            // object we fed via the data prop.
            const datum = evt?.data?.data;
            if (!datum || typeof datum.t !== 'number') return;
            const from = new Date(datum.t);
            const to = new Date(datum.t + stepSeconds * 1000);
            onZoom(from, to);
          });
        }}
        // Cursor hint that bars are clickable. G2 forwards style on
        // each element node; setting it via theme would also work
        // but this is more localized.
        style={{ cursor: onZoom ? 'pointer' : 'default' }}
        axis={{
          x: {
            labelFormatter: (val: any) => {
              const d = new Date(typeof val === 'number' ? val : Number(val));
              if (Number.isNaN(d.getTime())) return '';
              const hh = String(d.getHours()).padStart(2, '0');
              const mm = String(d.getMinutes()).padStart(2, '0');
              return `${hh}:${mm}`;
            },
          },
          y: { labelFormatter: (v: any) => fmt(v) },
        }}
        scale={{ y: { domainMin: 0 } }}
        tooltip={{
          title: (d: any) => new Date(d.t).toLocaleString(),
          items: [
            {
              field: 'count',
              valueFormatter: (v: any) => fmt(v),
            },
          ],
        }}
        theme={dark ? 'classicDark' : 'classic'}
        columnStyle={{ radius: [2, 2, 0, 0] }}
      />
    </div>
  );
}

function fmt(v: any): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

export default LoggingHistogram;
