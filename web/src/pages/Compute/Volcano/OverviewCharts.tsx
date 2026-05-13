import { Column, Gauge } from '@ant-design/plots';
import { useIntl } from '@umijs/max';
import {
  Card,
  Col,
  Empty,
  Row,
  Space,
  Tag,
  Tooltip,
  Tree,
  Typography,
} from 'antd';
import type { DataNode } from 'antd/es/tree';
import React, { useMemo } from 'react';

import type { BundleData } from './Overview';

const { Text } = Typography;

// OverviewCharts holds all the heavy @ant-design/plots renders.
// Lazy-imported from Overview.tsx so the G2 runtime only ships on
// dashboard open. Parent fetches everything once and passes the
// bundle here; each chart card derives its own shape with useMemo.

export default function OverviewCharts({ data }: { data: BundleData }) {
  const cluster = useMemo(() => clusterCapacity(data), [data]);
  const hasJobFlow = data.jobFlows.length > 0;
  const hasHyperNode = data.hyperNodes.length > 0;

  return (
    <>
      {/* Cluster capacity: 3 ring gauges side-by-side. GPU ring only
          renders when at least one queue has volcano.sh/vgpu-number
          or nvidia.com/gpu data. */}
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }} align="stretch">
        <Col xs={24} sm={12} md={cluster.hasGpu ? 8 : 12}>
          <CapacityGaugeCard
            titleId="pages.compute.overview.gauge.cpu"
            allocated={cluster.cpu.allocated}
            total={cluster.cpu.total}
            unit="cores"
          />
        </Col>
        <Col xs={24} sm={12} md={cluster.hasGpu ? 8 : 12}>
          <CapacityGaugeCard
            titleId="pages.compute.overview.gauge.memory"
            allocated={cluster.memory.allocated}
            total={cluster.memory.total}
            unit="GiB"
          />
        </Col>
        {cluster.hasGpu && (
          <Col xs={24} sm={12} md={8}>
            <CapacityGaugeCard
              titleId="pages.compute.overview.gauge.gpu"
              allocated={cluster.gpu.allocated}
              total={cluster.gpu.total}
              unit=""
            />
          </Col>
        )}
      </Row>

      <Row gutter={[12, 12]} align="stretch">
        <Col xs={24}>
          <QueueResourceCard data={data} />
        </Col>
        {/* Consolidated phase distribution: Job + PodGroup +
            (optionally) JobFlow rendered as horizontal stacked bars
            in one card. Replaces the 3 separate pie charts so phases
            are compared by length (which the eye reads well) instead
            of angle (which it doesn't), and so the 3-card row's worth
            of empty space disappears on small clusters. */}
        <Col xs={24}>
          <PhaseDistributionCard data={data} />
        </Col>
        <Col xs={24}>
          <JobByQueueCard data={data} />
        </Col>
        <Col xs={24} lg={12}>
          <QueueHierarchyCard data={data} />
        </Col>
        <Col xs={24} lg={12}>
          <PendingByQueueCard data={data} />
        </Col>
        {hasHyperNode && (
          <Col xs={24}>
            <HyperNodeTierCard data={data} />
          </Col>
        )}
      </Row>

      {/* Resources this cluster doesn't use yet are folded into a
          single compact "not in use" row instead of each rendering
          its own 300 px Empty card. Saves vertical space and keeps
          the dashboard's signal density high. */}
      {(!hasJobFlow || !hasHyperNode) && (
        <UnusedResourcesRow
          missing={[
            !hasJobFlow ? 'jobflows' : null,
            !hasHyperNode ? 'hypernodes' : null,
          ].filter((x): x is string => !!x)}
        />
      )}
    </>
  );
}

// ─── Cluster capacity gauges ──────────────────────────────────────────

function CapacityGaugeCard({
  titleId,
  allocated,
  total,
  unit,
}: {
  titleId: string;
  allocated: number;
  total: number;
  unit: string;
}) {
  const intl = useIntl();
  // Volcano queues can omit spec.capability — the queue is then
  // "unlimited" (capped only by physical cluster, which the overview
  // doesn't fetch). A gauge of "allocated / 0" is meaningless, so
  // when total == 0 we drop the ring and show the allocated number
  // alone with an "未限制 / unbounded" hint. Card height stays the
  // same as the ring case so the 3-column row doesn't jitter.
  const unbounded = total <= 0;
  const pct = unbounded ? 0 : Math.min(allocated / total, 1);
  const color = pct >= 0.85 ? '#ff4d4f' : pct >= 0.6 ? '#faad14' : '#52c41a';
  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={intl.formatMessage({ id: titleId })}
      styles={{ body: { padding: '4px 8px 8px' } }}
    >
      {unbounded ? (
        <div
          style={{
            height: 170,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <Tag color="default" style={{ marginInlineEnd: 0 }}>
            {intl.formatMessage({
              id: 'pages.compute.overview.gauge.unbounded',
            })}
          </Tag>
          <div style={{ fontSize: 28, fontWeight: 600 }}>
            {formatNum(allocated)}
            {unit ? (
              <span style={{ fontSize: 14, marginInlineStart: 4 }}>{unit}</span>
            ) : null}
          </div>
          <div
            style={{ fontSize: 12, color: 'var(--ant-color-text-tertiary)' }}
          >
            {intl.formatMessage({
              id: 'pages.compute.overview.gauge.allocatedOnly',
            })}
          </div>
        </div>
      ) : (
        <>
          <Gauge
            height={170}
            data={{ target: allocated, total, name: titleId }}
            scale={{ color: { range: ['#f0f0f0', color] } }}
            style={{ textContent: () => `${(pct * 100).toFixed(1)}%` }}
            legend={false}
          />
          <div
            style={{
              textAlign: 'center',
              fontSize: 12,
              color: 'var(--ant-color-text-secondary)',
            }}
          >
            {`${formatNum(allocated)} / ${formatNum(total)}${unit ? ' ' + unit : ''}`}
          </div>
        </>
      )}
    </Card>
  );
}

interface ClusterCapacity {
  cpu: { allocated: number; total: number };
  memory: { allocated: number; total: number }; // in GiB
  gpu: { allocated: number; total: number };
  hasGpu: boolean;
}

function clusterCapacity(data: BundleData): ClusterCapacity {
  let cpuT = 0,
    cpuA = 0,
    memT = 0,
    memA = 0,
    gpuT = 0,
    gpuA = 0,
    hasGpu = false;
  for (const q of data.queues) {
    cpuT += parseQuantity(q.capability?.['cpu']);
    cpuA += parseQuantity(q.allocated?.['cpu']);
    memT += parseQuantity(q.capability?.['memory']);
    memA += parseQuantity(q.allocated?.['memory']);
    const gT =
      parseQuantity(q.capability?.['volcano.sh/vgpu-number']) +
      parseQuantity(q.capability?.['nvidia.com/gpu']);
    const gA =
      parseQuantity(q.allocated?.['volcano.sh/vgpu-number']) +
      parseQuantity(q.allocated?.['nvidia.com/gpu']);
    gpuT += gT;
    gpuA += gA;
    if (
      q.capability?.['volcano.sh/vgpu-number'] ||
      q.capability?.['nvidia.com/gpu'] ||
      q.allocated?.['volcano.sh/vgpu-number'] ||
      q.allocated?.['nvidia.com/gpu']
    ) {
      hasGpu = true;
    }
  }
  return {
    cpu: { allocated: cpuA, total: cpuT },
    // Memory is bytes; convert to GiB for the gauge so the displayed
    // numbers stay readable.
    memory: { allocated: memA / 1024 ** 3, total: memT / 1024 ** 3 },
    gpu: { allocated: gpuA, total: gpuT },
    hasGpu,
  };
}

// ─── Queue resource usage (with optional GPU facets) ──────────────────

function QueueResourceCard({ data }: { data: BundleData }) {
  const intl = useIntl();
  // Build chart rows. Facets are added dynamically only when at least
  // one queue has data for them — keeps the chart compact on
  // GPU-less clusters.
  const { rows, hasGpu, hasNvidia } = useMemo(() => {
    let _hasGpu = false;
    let _hasNvidia = false;
    const out: {
      queue: string;
      metric: string;
      value: number;
      kind: string;
    }[] = [];
    for (const q of data.queues) {
      const cpuCap = parseQuantity(q.capability?.['cpu']);
      const cpuAlloc = parseQuantity(q.allocated?.['cpu']);
      const memCap = parseQuantity(q.capability?.['memory']);
      const memAlloc = parseQuantity(q.allocated?.['memory']);
      out.push(
        {
          queue: q.name,
          metric: 'cpu (cores)',
          value: cpuAlloc,
          kind: 'allocated',
        },
        {
          queue: q.name,
          metric: 'cpu (cores)',
          value: Math.max(cpuCap - cpuAlloc, 0),
          kind: 'free',
        },
        {
          queue: q.name,
          metric: 'memory (GiB)',
          value: memAlloc / 1024 ** 3,
          kind: 'allocated',
        },
        {
          queue: q.name,
          metric: 'memory (GiB)',
          value: Math.max((memCap - memAlloc) / 1024 ** 3, 0),
          kind: 'free',
        },
      );
      const vgpuCap = parseQuantity(q.capability?.['volcano.sh/vgpu-number']);
      const vgpuAlloc = parseQuantity(q.allocated?.['volcano.sh/vgpu-number']);
      if (vgpuCap > 0 || vgpuAlloc > 0) {
        _hasGpu = true;
        out.push(
          {
            queue: q.name,
            metric: 'vgpu',
            value: vgpuAlloc,
            kind: 'allocated',
          },
          {
            queue: q.name,
            metric: 'vgpu',
            value: Math.max(vgpuCap - vgpuAlloc, 0),
            kind: 'free',
          },
        );
      }
      const nvCap = parseQuantity(q.capability?.['nvidia.com/gpu']);
      const nvAlloc = parseQuantity(q.allocated?.['nvidia.com/gpu']);
      if (nvCap > 0 || nvAlloc > 0) {
        _hasNvidia = true;
        out.push(
          {
            queue: q.name,
            metric: 'nvidia.com/gpu',
            value: nvAlloc,
            kind: 'allocated',
          },
          {
            queue: q.name,
            metric: 'nvidia.com/gpu',
            value: Math.max(nvCap - nvAlloc, 0),
            kind: 'free',
          },
        );
      }
    }
    return { rows: out, hasGpu: _hasGpu, hasNvidia: _hasNvidia };
  }, [data.queues]);

  // Bump height as more facets show up so each one stays legible.
  const facetCount = 2 + (hasGpu ? 1 : 0) + (hasNvidia ? 1 : 0);
  const chartHeight = Math.max(280, facetCount * 100);

  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={intl.formatMessage({ id: 'pages.compute.overview.queues.title' })}
      extra={
        <Text type="secondary" style={{ fontSize: 12 }}>
          {intl.formatMessage(
            { id: 'pages.compute.overview.queues.subtitle' },
            { n: data.queues.length },
          )}
        </Text>
      }
    >
      {rows.length === 0 ? (
        <EmptyHint id="pages.compute.overview.queues.empty" />
      ) : (
        <Column
          height={chartHeight}
          data={rows}
          xField="queue"
          yField="value"
          colorField="kind"
          stack
          axis={{ x: { labelAutoRotate: true }, y: { title: false } }}
          legend={{ color: { position: 'top' } }}
          facet={{ type: 'rect', fields: ['metric'] }}
          scale={{
            color: {
              domain: ['allocated', 'free'],
              range: ['#1677ff', '#d9d9d9'],
            },
          }}
          tooltip={{
            title: (d: any) => `${d.queue} · ${d.metric}`,
            items: [
              {
                field: 'value',
                name: (d: any) => d.kind,
                valueFormatter: (v: number) => v.toFixed(2),
              },
            ],
          }}
        />
      )}
    </Card>
  );
}

// ─── Phase distribution (horizontal stacked bars) ─────────────────────

// Single canonical phase → color map. Shared by every phase
// visualization on the dashboard (Job, PodGroup, JobFlow, Queue × Job
// matrix) so a state always reads the same colour everywhere — e.g.
// Failed is red whether it's a Job or a PodGroup.
const PHASE_COLORS: Record<string, string> = {
  Running: '#52c41a',
  Succeed: '#52c41a', // JobFlow uses "Succeed" instead of Completed
  Completed: '#1677ff',
  Completing: '#1677ff',
  Pending: '#faad14',
  Inqueue: '#13c2c2',
  Failed: '#ff4d4f',
  Terminated: '#ff4d4f',
  Aborted: '#ff4d4f',
  Restarting: '#fa8c16',
  Terminating: '#fa8c16',
  Aborting: '#fa8c16',
  Unknown: '#bfbfbf',
};

function phaseColor(phase: string): string {
  return PHASE_COLORS[phase] ?? '#bfbfbf';
}

interface PhaseRow {
  phase: string;
  count: number;
}

function PhaseDistributionCard({ data }: { data: BundleData }) {
  const intl = useIntl();
  const jobRows = useMemo(
    () => tally(data.jobs.map((j) => j.state || 'Unknown')),
    [data.jobs],
  );
  const pgRows = useMemo(
    () => tally(data.podGroups.map((p) => p.phase || 'Unknown')),
    [data.podGroups],
  );
  const jfRows = useMemo(
    () => tally(data.jobFlows.map((j) => j.phase || 'Unknown')),
    [data.jobFlows],
  );

  // Hide JobFlow row when the cluster doesn't use them — most don't.
  const hasJobFlow = data.jobFlows.length > 0;
  const allEmpty = jobRows.length === 0 && pgRows.length === 0 && !hasJobFlow;

  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={intl.formatMessage({ id: 'pages.compute.overview.phases.title' })}
      extra={
        <Text type="secondary" style={{ fontSize: 12 }}>
          {intl.formatMessage({ id: 'pages.compute.overview.phases.subtitle' })}
        </Text>
      }
    >
      {allEmpty ? (
        <EmptyHint id="pages.compute.overview.jobs.empty" />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <StackedPhaseBar
            labelId="pages.compute.overview.phases.kind.job"
            rows={jobRows}
          />
          <StackedPhaseBar
            labelId="pages.compute.overview.phases.kind.podgroup"
            rows={pgRows}
          />
          {hasJobFlow && (
            <StackedPhaseBar
              labelId="pages.compute.overview.phases.kind.jobflow"
              rows={jfRows}
            />
          )}
        </Space>
      )}
    </Card>
  );
}

function tally(items: string[]): PhaseRow[] {
  const counts: Record<string, number> = {};
  for (const k of items) counts[k] = (counts[k] ?? 0) + 1;
  // Sort by canonical phase order so the bar always reads
  // pending → running → completed → failure left to right.
  return Object.entries(counts)
    .map(([phase, count]) => ({ phase, count }))
    .sort((a, b) => phaseOrder(a.phase) - phaseOrder(b.phase));
}

function phaseOrder(p: string): number {
  const order = [
    'Pending',
    'Inqueue',
    'Restarting',
    'Running',
    'Completing',
    'Completed',
    'Succeed',
    'Terminating',
    'Terminated',
    'Aborting',
    'Aborted',
    'Failed',
    'Unknown',
  ];
  const i = order.indexOf(p);
  return i < 0 ? 99 : i;
}

// StackedPhaseBar is a hand-rolled horizontal stacked bar. We
// intentionally avoid @ant-design/plots's Pie/Bar for this row —
// G2's label engine kept fighting us (spider labels clipped, inside
// labels need tuning per slice size), and a flex layout gives us
// perfect tooltip control + count placement for free.
function StackedPhaseBar({
  labelId,
  rows,
}: {
  labelId: string;
  rows: PhaseRow[];
}) {
  const intl = useIntl();
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div
        style={{
          width: 110,
          fontSize: 13,
          color: 'var(--ant-color-text-secondary)',
          flexShrink: 0,
        }}
      >
        {intl.formatMessage({ id: labelId })}
      </div>
      <div
        style={{
          flex: 1,
          height: 28,
          borderRadius: 4,
          overflow: 'hidden',
          background: 'var(--ant-color-fill-tertiary)',
          display: 'flex',
        }}
      >
        {total === 0
          ? null
          : rows.map((r) => (
              <Tooltip key={r.phase} title={`${r.phase}: ${r.count}`}>
                <div
                  style={{
                    flex: r.count,
                    background: phaseColor(r.phase),
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    fontSize: 12,
                    fontWeight: 600,
                    // White text on coloured background needs a tiny
                    // negative letter-spacing on Chinese to fit count
                    // text within narrow segments — but the simpler
                    // approach is just to hide labels that don't fit.
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                  }}
                >
                  {/* Show count inside the segment if it's wide enough
                    (≥ 6% of total width); otherwise rely on hover. */}
                  {r.count / total >= 0.06 ? r.count : null}
                </div>
              </Tooltip>
            ))}
      </div>
      <div
        style={{
          width: 60,
          textAlign: 'right',
          fontSize: 12,
          color: 'var(--ant-color-text-tertiary)',
          flexShrink: 0,
        }}
      >
        Σ {total}
      </div>
      <div
        style={{
          flexBasis: '100%',
          // Legend chip row sits directly under each bar so the
          // colour → phase mapping is unambiguous without per-row
          // duplication.
          marginTop: -6,
          marginLeft: 122,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
        }}
      >
        {rows.map((r) => (
          <span
            key={r.phase}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              color: 'var(--ant-color-text-secondary)',
            }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: 2,
                background: phaseColor(r.phase),
              }}
            />
            {r.phase} ({r.count})
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Job × Queue matrix ───────────────────────────────────────────────

function JobByQueueCard({ data }: { data: BundleData }) {
  const intl = useIntl();
  // Group by (queue, state) -> count. Surfaces which queues are
  // hot or accumulating failures. Stacked column with the unified
  // phase color map so it reads the same as the phase distribution
  // bars above.
  const rows = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const j of data.jobs) {
      const q = j.queue || 'default';
      const st = j.state || 'Unknown';
      if (!map.has(q)) map.set(q, new Map());
      const sub = map.get(q)!;
      sub.set(st, (sub.get(st) ?? 0) + 1);
    }
    const out: { queue: string; state: string; count: number }[] = [];
    for (const [q, sub] of map.entries()) {
      for (const [st, n] of sub.entries()) {
        out.push({ queue: q, state: st, count: n });
      }
    }
    return out;
  }, [data.jobs]);
  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={intl.formatMessage({
        id: 'pages.compute.overview.jobByQueue.title',
      })}
      extra={
        <Text type="secondary" style={{ fontSize: 12 }}>
          {intl.formatMessage({
            id: 'pages.compute.overview.jobByQueue.subtitle',
          })}
        </Text>
      }
    >
      {rows.length === 0 ? (
        <EmptyHint id="pages.compute.overview.jobByQueue.empty" />
      ) : (
        <Column
          height={280}
          data={rows}
          xField="queue"
          yField="count"
          colorField="state"
          stack
          axis={{ x: { labelAutoRotate: true } }}
          legend={{ color: { position: 'top' } }}
          scale={{
            color: {
              domain: Object.keys(PHASE_COLORS),
              range: Object.values(PHASE_COLORS),
            },
          }}
          tooltip={{
            title: (d: any) => `${d.queue} · ${d.state}`,
            items: [{ field: 'count', name: 'jobs' }],
          }}
        />
      )}
    </Card>
  );
}

// ─── Queue hierarchy (antd Tree) ──────────────────────────────────────

interface QueueNodeBuild {
  name: string;
  parent?: string;
  state?: string;
  cpuAlloc: number;
  cpuCap: number;
  children: QueueNodeBuild[];
}

function QueueHierarchyCard({ data }: { data: BundleData }) {
  const intl = useIntl();
  // Render queues as an indented antd Tree instead of a sunburst —
  // hierarchies are shallow (1-2 levels) and a tree gives us per-row
  // affordances (state chip, cpu allocated/cap) that a polar chart
  // can't.
  const { treeData, hasHierarchy } = useMemo<{
    treeData: DataNode[];
    hasHierarchy: boolean;
  }>(() => {
    if (data.queues.length === 0) {
      return { treeData: [], hasHierarchy: false };
    }
    const byName = new Map<string, QueueNodeBuild>();
    for (const q of data.queues) {
      byName.set(q.name, {
        name: q.name,
        parent: q.parent || undefined,
        state: q.state,
        cpuAlloc: parseQuantity(q.allocated?.['cpu']),
        cpuCap: parseQuantity(q.capability?.['cpu']),
        children: [],
      });
    }
    const roots: QueueNodeBuild[] = [];
    let nested = false;
    for (const node of byName.values()) {
      if (node.parent && byName.has(node.parent)) {
        byName.get(node.parent)!.children.push(node);
        nested = true;
      } else {
        roots.push(node);
      }
    }
    const toNode = (n: QueueNodeBuild): DataNode => ({
      key: n.name,
      title: <QueueTreeLabel node={n} />,
      children: n.children.length > 0 ? n.children.map(toNode) : undefined,
    });
    return { treeData: roots.map(toNode), hasHierarchy: nested };
  }, [data.queues]);
  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={intl.formatMessage({
        id: 'pages.compute.overview.hierarchy.title',
      })}
      extra={
        <Text type="secondary" style={{ fontSize: 12 }}>
          {hasHierarchy
            ? intl.formatMessage({
                id: 'pages.compute.overview.hierarchy.subtitle',
              })
            : intl.formatMessage({
                id: 'pages.compute.overview.hierarchy.flat',
              })}
        </Text>
      }
      styles={{
        body: { padding: '12px 16px', maxHeight: 320, overflow: 'auto' },
      }}
    >
      {treeData.length === 0 ? (
        <EmptyHint id="pages.compute.overview.hierarchy.empty" />
      ) : (
        <Tree
          treeData={treeData}
          defaultExpandAll
          showLine={hasHierarchy}
          blockNode
          selectable={false}
        />
      )}
    </Card>
  );
}

function QueueTreeLabel({ node }: { node: QueueNodeBuild }) {
  const intl = useIntl();
  const ratio = node.cpuCap > 0 ? Math.min(node.cpuAlloc / node.cpuCap, 1) : 0;
  const ratioColor =
    ratio >= 0.85
      ? 'var(--ant-color-error)'
      : ratio >= 0.6
        ? 'var(--ant-color-warning)'
        : 'var(--ant-color-text-tertiary)';
  return (
    <Space size={8} wrap style={{ width: '100%' }}>
      <Text strong style={{ fontSize: 13 }}>
        {node.name}
      </Text>
      {node.state && (
        <Tag
          color={node.state === 'Open' ? 'green' : 'default'}
          style={{ marginInlineEnd: 0 }}
        >
          {node.state}
        </Tag>
      )}
      {node.cpuCap > 0 ? (
        <Text style={{ fontSize: 12, color: ratioColor }}>
          cpu {formatNum(node.cpuAlloc)} / {formatNum(node.cpuCap)} ·{' '}
          {(ratio * 100).toFixed(0)}%
        </Text>
      ) : (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {intl.formatMessage({
            id: 'pages.compute.overview.gauge.unbounded',
          })}{' '}
          · cpu {formatNum(node.cpuAlloc)}
        </Text>
      )}
    </Space>
  );
}

// ─── Pending Pods by Queue ────────────────────────────────────────────

function PendingByQueueCard({ data }: { data: BundleData }) {
  const intl = useIntl();
  // Sum jobs[].pending grouped by queue. Surfaces *which* queue is
  // backlogged — the cluster-level Pending KPI tells you something is
  // wrong, this tells you where to look.
  const rows = useMemo(() => {
    const m = new Map<string, number>();
    for (const j of data.jobs) {
      if ((j.pending ?? 0) > 0) {
        const q = j.queue || 'default';
        m.set(q, (m.get(q) ?? 0) + (j.pending ?? 0));
      }
    }
    return Array.from(m.entries())
      .map(([queue, pending]) => ({ queue, pending }))
      .sort((a, b) => b.pending - a.pending)
      .slice(0, 10);
  }, [data.jobs]);

  const max = rows.reduce((s, r) => Math.max(s, r.pending), 0);

  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={intl.formatMessage({
        id: 'pages.compute.overview.pendingByQueue.title',
      })}
      extra={
        <Text type="secondary" style={{ fontSize: 12 }}>
          {intl.formatMessage({
            id: 'pages.compute.overview.pendingByQueue.subtitle',
          })}
        </Text>
      }
      styles={{
        body: { padding: '12px 16px', maxHeight: 320, overflow: 'auto' },
      }}
    >
      {rows.length === 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 200,
          }}
        >
          <Text type="secondary">
            {intl.formatMessage({
              id: 'pages.compute.overview.pendingByQueue.empty',
            })}
          </Text>
        </div>
      ) : (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          {rows.map((r) => {
            const pct = max > 0 ? r.pending / max : 0;
            return (
              <div
                key={r.queue}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <div
                  style={{
                    width: 120,
                    fontSize: 13,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    flexShrink: 0,
                  }}
                  title={r.queue}
                >
                  {r.queue}
                </div>
                <div
                  style={{
                    flex: 1,
                    height: 18,
                    background: 'var(--ant-color-fill-tertiary)',
                    borderRadius: 2,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${pct * 100}%`,
                      height: '100%',
                      background: phaseColor('Pending'),
                    }}
                  />
                </div>
                <div
                  style={{
                    width: 40,
                    textAlign: 'right',
                    fontSize: 13,
                    fontWeight: 500,
                    flexShrink: 0,
                  }}
                >
                  {r.pending}
                </div>
              </div>
            );
          })}
        </Space>
      )}
    </Card>
  );
}

// ─── HyperNode tier histogram ─────────────────────────────────────────

function HyperNodeTierCard({ data }: { data: BundleData }) {
  const intl = useIntl();
  const rows = useMemo(() => {
    const counts: Record<number, number> = {};
    for (const h of data.hyperNodes) {
      const t = h.tier ?? 0;
      counts[t] = (counts[t] ?? 0) + 1;
    }
    return Object.entries(counts)
      .map(([tier, count]) => ({ tier: `tier ${tier}`, count }))
      .sort((a, b) => a.tier.localeCompare(b.tier));
  }, [data.hyperNodes]);
  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={intl.formatMessage({
        id: 'pages.compute.overview.hypernodes.title',
      })}
      extra={
        <Text type="secondary" style={{ fontSize: 12 }}>
          {intl.formatMessage(
            { id: 'pages.compute.overview.hypernodes.subtitle' },
            { n: data.hyperNodes.length },
          )}
        </Text>
      }
    >
      <Column
        height={220}
        data={rows}
        xField="tier"
        yField="count"
        label={{ position: 'top' }}
        style={{ fill: '#1677ff' }}
        tooltip={{
          title: (d: any) => d.tier,
          items: [{ field: 'count', name: 'HyperNodes' }],
        }}
      />
    </Card>
  );
}

// ─── Unused-resource collapsed banner ─────────────────────────────────

function UnusedResourcesRow({ missing }: { missing: string[] }) {
  const intl = useIntl();
  if (missing.length === 0) return null;
  return (
    <Card
      size="small"
      style={{ marginTop: 12 }}
      styles={{ body: { padding: '10px 14px' } }}
    >
      <Space wrap size={[8, 8]}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {intl.formatMessage({
            id: 'pages.compute.overview.unused.title',
          })}
        </Text>
        {missing.map((m) => (
          <Tag key={m} style={{ marginInlineEnd: 0 }}>
            {intl.formatMessage({
              id: `pages.compute.overview.unused.${m}`,
            })}
          </Tag>
        ))}
      </Space>
    </Card>
  );
}

function EmptyHint({ id }: { id: string }) {
  const intl = useIntl();
  return (
    <div
      style={{
        height: 240,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={intl.formatMessage({ id })}
      />
    </div>
  );
}

function formatNum(n: number): string {
  if (n === 0) return '0';
  if (n < 1) return n.toFixed(2);
  if (n < 100) return n.toFixed(1);
  return Math.round(n).toString();
}

// parseQuantity is the same best-effort K8s Quantity translator used
// in the original chart file. Handles cpu millicores (`m` suffix),
// binary prefixes (Ki/Mi/Gi/Ti/Pi), and decimal SI prefixes (K/M/G/
// T/P). Charts are illustrative, not balance-sheet exact.
function parseQuantity(raw: string | undefined): number {
  if (!raw) return 0;
  const s = raw.trim();
  if (!s) return 0;
  if (s.endsWith('m')) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n / 1000 : 0;
  }
  const binPrefixes: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
  };
  for (const [p, mul] of Object.entries(binPrefixes)) {
    if (s.endsWith(p)) {
      const n = Number(s.slice(0, -p.length));
      return Number.isFinite(n) ? n * mul : 0;
    }
  }
  const decPrefixes: Record<string, number> = {
    K: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
    P: 1000 ** 5,
  };
  for (const [p, mul] of Object.entries(decPrefixes)) {
    if (s.endsWith(p)) {
      const n = Number(s.slice(0, -p.length));
      return Number.isFinite(n) ? n * mul : 0;
    }
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
