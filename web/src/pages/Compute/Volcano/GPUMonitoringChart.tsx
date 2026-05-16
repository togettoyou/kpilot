import { Line } from '@ant-design/plots';
import { useIntl } from '@umijs/max';
import { Card, Empty, Space, Typography } from 'antd';
import React, { useMemo } from 'react';

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

interface MetricChartCardProps {
  titleId: string;
  unit: string;
  yMax?: number;
  unitScale?: number;
  seriesRows: GPUMetricSeries[];
  dark: boolean;
}

function MetricChartCard({
  titleId,
  unit,
  yMax,
  unitScale,
  seriesRows,
  dark,
}: MetricChartCardProps) {
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
                field: 'v',
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

export default MetricChartCard;
