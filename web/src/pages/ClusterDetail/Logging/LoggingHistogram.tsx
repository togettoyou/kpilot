import { Column } from '@ant-design/plots';
import { useIntl } from '@umijs/max';
import { Empty } from 'antd';
import React, { useMemo } from 'react';

import type { LogsHistogramPoint } from '@/services/kpilot/logs';

// Histogram chart for the Logging page. Same lazy-load pattern as
// MonitoringCharts — the @ant-design/plots G2 runtime only ships when
// this component renders.

interface LoggingHistogramProps {
  points: LogsHistogramPoint[];
  dark: boolean;
  height?: number;
}

function LoggingHistogram({ points, dark, height = 140 }: LoggingHistogramProps) {
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
