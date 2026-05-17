import { Line } from '@ant-design/plots';
import { useIntl } from '@umijs/max';
import { Card, Empty, Space, Tooltip, Typography } from 'antd';
import React, { useCallback, useMemo, useState } from 'react';

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
  /** Optional fixed height for the plot area (default 220). The
   *  scrollable HTML legend below adds its own height budget on top. */
  height?: number;
  /** Force the legend to render even when there's only one series.
   *  Default skips the legend for single-series charts (cluster CPU
   *  / memory trends — the series name is the cluster itself,
   *  conveyed by the title already). Set true for node- and pod-
   *  level charts: a single-node / single-pod result still benefits
   *  from showing WHICH node or pod the line belongs to. */
  alwaysShowLegend?: boolean;
}

const plotHeight = 220;
// Fixed-height scrollable legend area. With ~22px per row the user
// always sees ~5 entries; scrolling reveals the rest. Predictable
// card height regardless of series count (3 nodes vs 20 pods render
// the same shape), no clipping.
const legendScrollerHeight = 110;

// Fixed palette so the HTML legend's color square matches the
// chart's line color exactly. We feed this same array into G2 via
// scale.color.range and use the same index order in the HTML
// legend below. Picks roughly follow the antd brand palette so
// dark + light modes both look ok.
const seriesPalette = [
  '#1677ff', '#52c41a', '#fa8c16', '#eb2f96',
  '#722ed1', '#13c2c2', '#faad14', '#f5222d',
  '#2f54eb', '#a0d911', '#fa541c', '#9254de',
  '#08979c', '#fadb14', '#cf1322', '#1d39c4',
  '#7cb305', '#d4380d', '#531dab', '#006d75',
];

function colorFor(index: number): string {
  return seriesPalette[index % seriesPalette.length];
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
  alwaysShowLegend = false,
}: MultiSeriesChartProps) {
  const intl = useIntl();

  // Sort series names alphabetically so the legend order is stable
  // across refreshes. G2 by default reorders by data appearance,
  // which makes the legend "jump" when a series briefly drops out.
  const sortedNames = useMemo(() => {
    const set = new Set<string>();
    for (const s of series) set.add(s.name);
    return [...set].sort();
  }, [series]);

  // colorByName backs both the chart line color (via scale.color
  // domain+range) and the legend square — same index, same hex.
  const colorByName = useMemo(() => {
    const m = new Map<string, string>();
    sortedNames.forEach((n, i) => m.set(n, colorFor(i)));
    return m;
  }, [sortedNames]);

  // Hidden set tracks legend toggles — clicking a row hides that
  // series from the chart; clicking again restores it. Persisted in
  // component state so re-renders don't reset the user's choice.
  // Kept as a Set<string> so toggle is O(1) and we don't depend on
  // array order.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const toggleHidden = useCallback((name: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const flat: FlatPoint[] = useMemo(() => {
    const scale = unitScale ?? 1;
    const out: FlatPoint[] = [];
    for (const row of series) {
      if (hidden.has(row.name)) continue;
      for (const p of row.points) {
        out.push({ t: p.ts, v: p.value * scale, series: row.name });
      }
    }
    return out;
  }, [series, unitScale, hidden]);

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

  // Empty-state branch: only when the upstream data truly has no
  // points, not when the user filtered everything out via the legend.
  // Hiding every series should still show the legend so the user can
  // toggle one back on; we just render an empty plot area in that case.
  const upstreamEmpty = series.every((s) => s.points.length === 0);
  if (upstreamEmpty) {
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

  const plotPx = typeof height === 'number' ? height : plotHeight;

  return (
    <Card title={title} size="small" styles={{ body: { padding: 16 } }}>
      <div style={{ height: plotPx }}>
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
            // Pin every series to its assigned color. G2 would
            // otherwise pick from its default palette in insertion
            // order, which doesn't match the HTML legend underneath.
            color: {
              domain: sortedNames,
              range: sortedNames.map((n) => colorByName.get(n)!),
            },
          }}
          // Disable G2's built-in legend: long ns/pod names made it
          // unscrollable and the wrap+truncate workarounds were ugly
          // or hid content. The HTML legend below scrolls natively
          // and shows full names.
          legend={false}
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

      {/* Scrollable HTML legend — fixed height, native overflow,
          full names. Color square matches G2's line color through
          the shared colorByName mapping above. Cluster-trend
          charts (single synthetic series) skip the legend by
          default; node / pod charts opt in via alwaysShowLegend
          so a single-node cluster still sees the node name. */}
      {(alwaysShowLegend || sortedNames.length > 1) && (
      <div
        style={{
          maxHeight: legendScrollerHeight,
          overflowY: 'auto',
          marginTop: 8,
          paddingRight: 4,
          // Subtle visual seam between chart and legend so the
          // scrollable area reads as a separate region.
          borderTop: '1px solid var(--ant-color-split)',
          paddingTop: 8,
        }}
      >
        {sortedNames.map((name) => {
          const isHidden = hidden.has(name);
          const color = colorByName.get(name);
          return (
            <div
              key={name}
              role="button"
              tabIndex={0}
              onClick={() => toggleHidden(name)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggleHidden(name);
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '2px 0',
                fontSize: 12,
                lineHeight: '18px',
                cursor: 'pointer',
                userSelect: 'none',
                opacity: isHidden ? 0.4 : 1,
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  // Hidden series: hollow ring of the same color so
                  // the user still sees which series the row belongs
                  // to. Visible: filled.
                  background: isHidden ? 'transparent' : color,
                  border: isHidden ? `2px solid ${color}` : 'none',
                  boxSizing: 'border-box',
                  flexShrink: 0,
                }}
              />
              <Tooltip title={name} mouseEnterDelay={0.5}>
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    textDecoration: isHidden ? 'line-through' : 'none',
                    color: 'var(--ant-color-text-secondary)',
                  }}
                >
                  {name}
                </span>
              </Tooltip>
            </div>
          );
        })}
      </div>
      )}
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
