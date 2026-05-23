import { Line } from '@ant-design/plots';
import { Card, Empty } from 'antd';
import React from 'react';

// SystemChart is a thin Line wrapper with the conventions the System
// pages use: timestamp x-axis (unix ms), numeric y-axis, multi-series
// support. Split into its own file so React.lazy can defer the
// @ant-design/plots G2 runtime (~250 KB gzip) until the user opens
// the detail page.

export interface SystemSeries {
  name: string;
  points: { t: number; v: number }[];
}

interface Props {
  title: React.ReactNode;
  unit?: string;
  unitScale?: number;
  series: SystemSeries[];
  height?: number;
  // Round percent values to one decimal; bytes etc. usually want 2.
  decimals?: number;
}

interface Flat {
  t: number;
  v: number;
  series: string;
}

function SystemChart({ title, unit, unitScale, series, height, decimals }: Props) {
  const scale = unitScale ?? 1;
  const dec = decimals ?? 2;

  const flat: Flat[] = React.useMemo(() => {
    const out: Flat[] = [];
    for (const row of series) {
      for (const p of row.points) {
        out.push({ t: p.t, v: p.v * scale, series: row.name });
      }
    }
    return out;
  }, [series, scale]);

  const hasData = flat.length > 0;
  const h = height ?? 220;

  return (
    <Card size="small" title={title} style={{ height: '100%' }} styles={{ body: { padding: 12 } }}>
      <div style={{ width: '100%', height: h, overflow: 'hidden' }}>
        {hasData ? (
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
                  const ss = String(d.getSeconds()).padStart(2, '0');
                  return `${hh}:${mm}:${ss}`;
                },
              },
              y: {
                labelFormatter: (v: any) =>
                  `${Number(v).toFixed(dec)}${unit ? ' ' + unit : ''}`,
              },
            }}
            scale={{ y: { domainMin: 0 } }}
            legend={{ color: { itemMarker: 'circle' } }}
            tooltip={{
              title: (datum: any) => {
                const d = new Date(datum.t);
                return d.toLocaleTimeString();
              },
              items: [
                {
                  field: 'v',
                  valueFormatter: (v: any) =>
                    `${Number(v).toFixed(dec)}${unit ? ' ' + unit : ''}`,
                },
              ],
            }}
            interaction={{ tooltip: { shared: true } }}
            style={{ lineWidth: 1.5 }}
            animate={false}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description=""
            style={{ marginTop: 32 }}
          />
        )}
      </div>
    </Card>
  );
}

export default SystemChart;
