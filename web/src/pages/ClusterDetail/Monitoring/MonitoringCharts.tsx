import { Line } from '@ant-design/plots';
import { useIntl } from '@umijs/max';
import { Card, Empty, Space, Typography } from 'antd';
import React, { useMemo } from 'react';

// Shared lazy-loaded chart bundle for the Monitoring page. The Line
// component pulls in the full @ant-design/plots G2 runtime (~250 KB
// gzip); GPUMonitoring already does this dance — we follow the same
// pattern so the cluster main route doesn't get any heavier when this
// chart is added.

interface TimePoint {
  ts: number;
  value: number;
}

export interface ChartSeriesInput {
  /** Stable name shown in the legend. */
  name: string;
  points: TimePoint[];
}

interface MultiSeriesChartProps {
  titleId: string;
  unit: string;
  /** Stable suffix appended to the title (e.g. "(top 20)"). */
  titleSuffix?: string;
  /** Override Y-axis ceiling. Defaults to auto-fit. */
  yMax?: number;
  /** Multiplier applied at draw time (e.g. 1/1024/1024/1024 for GiB). */
  unitScale?: number;
  series: ChartSeriesInput[];
  dark: boolean;
  /** Optional fixed height for the chart container. When unset the
   *  height adapts to the number of legend rows so 20-pod / many-node
   *  charts don't truncate labels behind a 2-row legend strip. */
  height?: number;
}

// Pixel budget. Plot area stays ~200px regardless of series count,
// the legend strip grows underneath to accommodate wrapped rows.
const basePlotHeight = 200;
const legendRowHeight = 22;
const legendRowGutter = 6;
// itemsPerLegendRow is the realistic packing density after we
// truncate the series name in `legendLabel` below — 2 items fit per
// row in a half-width chart card. maxLegendRows lets the legend
// span enough rows to render 20 series even when each one is on its
// own line (worst case: very long ns/pod combos).
const itemsPerLegendRow = 2;
const maxLegendRows = 12;

// legendLabel keeps the legend readable when pod / node names are
// long. Applied via G2's labelFormatter so the underlying `series`
// field stays intact — tooltips on hover still show the full name.
// Cut from the start, prepend an ellipsis: pod identity lives in
// the suffix (deployment hash + ordinal), the namespace prefix is
// the lower-information part.
function legendLabel(raw: string, max = 26): string {
  if (raw.length <= max) return raw;
  return '…' + raw.slice(raw.length - (max - 1));
}

interface FlatPoint {
  t: number;
  v: number;
  series: string;
}

function MultiSeriesChart({
  titleId,
  unit,
  titleSuffix,
  yMax,
  unitScale,
  series,
  dark,
  height,
}: MultiSeriesChartProps) {
  const intl = useIntl();

  const flat: FlatPoint[] = useMemo(() => {
    const scale = unitScale ?? 1;
    const out: FlatPoint[] = [];
    for (const row of series) {
      for (const p of row.points) {
        out.push({ t: p.ts, v: p.value * scale, series: row.name });
      }
    }
    return out;
  }, [series, unitScale]);

  // Pick a chart container height that gives the wrapped legend
  // enough room. With 10 nodes the old fixed 220px hid everything
  // past the 2nd label; now we add a row of vertical budget per
  // ~4 legend items, capped at maxLegendRows so a 100-pod query
  // doesn't blow up to a screen-tall card.
  const resolvedHeight = useMemo(() => {
    if (typeof height === 'number') return height;
    const rows = Math.min(
      maxLegendRows,
      Math.max(1, Math.ceil(series.length / itemsPerLegendRow)),
    );
    return basePlotHeight + rows * legendRowHeight + (rows - 1) * legendRowGutter;
  }, [height, series.length]);

  const title = (
    <Space>
      <Typography.Text strong>
        {intl.formatMessage({ id: titleId })}
      </Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        ({unit})
        {titleSuffix && ` ${titleSuffix}`}
      </Typography.Text>
    </Space>
  );

  if (flat.length === 0) {
    return (
      <Card title={title} size="small" styles={{ body: { padding: 16 } }}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={intl.formatMessage({
            id: 'pages.monitoring.chartEmpty',
          })}
        />
      </Card>
    );
  }

  return (
    <Card title={title} size="small" styles={{ body: { padding: 16 } }}>
      <div style={{ height: resolvedHeight }}>
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
          scale={{
            y: yMax ? { domainMin: 0, domainMax: yMax } : { domainMin: 0 },
          }}
          // Wrap legend items so 10+ nodes / 20 pods don't get
          // clipped behind a fixed-width strip. maxRows caps the
          // vertical budget the wrap can claim; rowPadding adds
          // breathing room between rows. labelFormatter shortens
          // long ns/pod names just for the legend — tooltip / data
          // still see the full name.
          legend={{
            color: {
              itemMarker: 'circle',
              autoWrap: true,
              maxRows: maxLegendRows,
              rowPadding: legendRowGutter,
              labelFormatter: (val: any) => legendLabel(String(val)),
            },
          }}
          tooltip={{
            title: (d: any) => new Date(d.t).toLocaleString(),
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

function fmtAxis(v: any): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(1);
  return n.toFixed(2);
}

export default MultiSeriesChart;
