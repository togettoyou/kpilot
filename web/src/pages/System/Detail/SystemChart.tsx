import { Line } from '@ant-design/plots';
import { Card, Empty } from 'antd';
import { useThemeMode } from 'antd-style';
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
  // G2 ships two named themes ('classic' / 'classicDark') that match
  // antd's light/dark token sets. Without this the chart axis labels
  // and gridlines stay light-gray over the dark background and become
  // unreadable.
  const { appearance } = useThemeMode();
  const dark = appearance === 'dark';

  const flat: Flat[] = React.useMemo(() => {
    const out: Flat[] = [];
    for (const row of series) {
      for (const p of row.points) {
        out.push({ t: p.t, v: p.v * scale, series: row.name });
      }
    }
    return out;
  }, [series, scale]);

  // Span between earliest and latest data point in ms. Used to pick
  // the x-axis tick format: ranges spanning > 24h need the date on
  // each tick (otherwise "08:00" appears twice and you can't tell
  // yesterday's 8am from today's). Sub-day ranges stay compact at
  // hh:mm:ss so ticks fit without rotation.
  const span = React.useMemo(() => {
    if (flat.length < 2) return 0;
    let min = Infinity;
    let max = -Infinity;
    for (const p of flat) {
      if (p.t < min) min = p.t;
      if (p.t > max) max = p.t;
    }
    return max - min;
  }, [flat]);
  const showDateOnAxis = span > 24 * 3600 * 1000;

  const hasData = flat.length > 0;
  const h = height ?? 220;

  return (
    <Card size="small" title={title} style={{ height: '100%' }} styles={{ body: { padding: 12 } }}>
      {/* overflow: visible so G2's tooltip (rendered inside this
          wrapper div) isn't clipped at the card's content edge —
          multi-series tooltips routinely extend above/right of the
          hovered point. animate={false} on Line means no transient
          chart-content bleed during resize, so visible is safe. */}
      <div style={{ width: '100%', height: h, overflow: 'visible' }}>
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
                  if (showDateOnAxis) {
                    const M = String(d.getMonth() + 1).padStart(2, '0');
                    const D = String(d.getDate()).padStart(2, '0');
                    return `${M}-${D} ${hh}:${mm}`;
                  }
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
              // Always full YYYY-MM-DD HH:MM:SS in the tooltip so the
              // operator never has to wonder which day a point belongs
              // to (especially when comparing today vs yesterday on the
              // same chart).
              title: (datum: any) => {
                const d = new Date(datum.t);
                if (Number.isNaN(d.getTime())) return '';
                const Y = d.getFullYear();
                const M = String(d.getMonth() + 1).padStart(2, '0');
                const D = String(d.getDate()).padStart(2, '0');
                const hh = String(d.getHours()).padStart(2, '0');
                const mm = String(d.getMinutes()).padStart(2, '0');
                const ss = String(d.getSeconds()).padStart(2, '0');
                return `${Y}-${M}-${D} ${hh}:${mm}:${ss}`;
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
            theme={dark ? 'classicDark' : 'classic'}
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
