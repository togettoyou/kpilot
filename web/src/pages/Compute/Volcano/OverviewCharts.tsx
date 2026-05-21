import { ExclamationCircleFilled } from '@ant-design/icons';
import { Column } from '@ant-design/plots';
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
  theme,
} from 'antd';
import type { DataNode } from 'antd/es/tree';
import React, { useMemo } from 'react';

import type { BundleData } from './Overview';
import { parseQuantity, usageColor } from './shared/utils';

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
      {/* Cluster capacity: three horizontal usage bars in one card.
          Replaced the previous ring-gauge trio — ring gauges aren't
          great at conveying utilization at a glance (you read the
          number, not the angle), and the new layout matches the
          Pending-by-Queue card below for visual rhythm. GPU row only
          renders when at least one queue declared GPU resources. */}
      <ClusterCapacityCard cluster={cluster} />

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

// ─── Cluster capacity (horizontal utilization bars) ───────────────────

function ClusterCapacityCard({ cluster }: { cluster: ClusterCapacity }) {
  const intl = useIntl();
  return (
    <Card
      size="small"
      style={{ marginBottom: 12 }}
      title={intl.formatMessage({
        id: 'pages.compute.overview.capacity.title',
      })}
      styles={{ body: { padding: '14px 16px' } }}
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <CapacityRow
          labelId="pages.compute.overview.gauge.cpu"
          allocated={cluster.cpu.allocated}
          total={cluster.cpu.total}
          unit="cores"
        />
        <CapacityRow
          labelId="pages.compute.overview.gauge.memory"
          allocated={cluster.memory.allocated}
          total={cluster.memory.total}
          unit="GiB"
        />
        {cluster.hasGpu && (
          <CapacityRow
            labelId="pages.compute.overview.gauge.gpu"
            allocated={cluster.gpu.allocated}
            total={cluster.gpu.total}
            unit={cluster.gpuUnit === 'GiB' ? 'GiB' : ''}
          />
        )}
      </Space>
    </Card>
  );
}

function CapacityRow({
  labelId,
  allocated,
  total,
  unit,
}: {
  labelId: string;
  allocated: number;
  total: number;
  unit: string;
}) {
  const intl = useIntl();
  const { token } = theme.useToken();
  // Volcano queues can omit spec.capability — the queue is then
  // "unlimited" (capped only by physical cluster, which the overview
  // doesn't fetch). With no denominator a utilization bar would just
  // be a flat zero, so the unbounded branch renders an empty track +
  // an "unbounded · N <unit> allocated" hint on the right instead.
  const unbounded = total <= 0;
  const pct = unbounded ? 0 : Math.min(allocated / total, 1);
  const color = usageColor(pct, token);
  const overloaded = pct >= 0.85;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
      }}
    >
      <div
        style={{
          width: 80,
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
          height: 18,
          // Diagonal stripes for unbounded clusters so the empty bar
          // doesn't read as "0% used" — see the same pattern in
          // UtilCell below.
          background: unbounded
            ? 'repeating-linear-gradient(45deg, var(--ant-color-fill-tertiary) 0 6px, transparent 6px 12px)'
            : 'var(--ant-color-fill-tertiary)',
          borderRadius: 3,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {!unbounded && (
          <div
            style={{
              width: `${pct * 100}%`,
              height: '100%',
              background: color,
              transition: 'width 0.3s ease-out',
            }}
          />
        )}
      </div>
      <div
        style={{
          minWidth: 200,
          textAlign: 'right',
          fontSize: 13,
          fontVariantNumeric: 'tabular-nums',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 6,
        }}
      >
        {unbounded ? (
          <>
            <span style={{ color: 'var(--ant-color-text-secondary)' }}>
              {formatNum(allocated)} / ∞{unit ? ` ${unit}` : ''}
            </span>
            <Tag style={{ marginInlineEnd: 0, fontSize: 11 }} color="default">
              {intl.formatMessage({
                id: 'pages.compute.overview.gauge.unbounded',
              })}
            </Tag>
          </>
        ) : (
          <>
            <span style={{ color: 'var(--ant-color-text-secondary)' }}>
              {formatNum(allocated)} / {formatNum(total)}
              {unit ? ` ${unit}` : ''}
            </span>
            <span style={{ color, fontWeight: 600 }}>
              {(pct * 100).toFixed(1)}%
            </span>
            {overloaded && (
              <Tooltip
                title={intl.formatMessage({
                  id: 'pages.compute.overview.capacity.overloaded',
                })}
              >
                <ExclamationCircleFilled style={{ color: token.colorError }} />
              </Tooltip>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface ClusterCapacity {
  cpu: { allocated: number; total: number };
  memory: { allocated: number; total: number }; // in GiB
  gpu: { allocated: number; total: number };
  // 'GiB' when at least one queue declares `volcano.sh/vgpu-memory`
  // (HAMi vGPU mode — memory is the meaningful capacity signal);
  // 'count' otherwise (integer cards via `nvidia.com/gpu` or slot
  // counts via `vgpu-number`).
  gpuUnit: 'GiB' | 'count';
  hasGpu: boolean;
}

function clusterCapacity(data: BundleData): ClusterCapacity {
  // Hierarchical queues: a parent's status.allocated is the rolled-up
  // sum of its descendants', and spec.capability is the cap for the
  // whole subtree. Summing every queue double-counts (parent + each
  // child), so cluster-wide totals come from the *roots only* —
  // queues whose `parent` is empty or refers to a queue that isn't
  // in our list. The root's rollup already covers everything below.
  const names = new Set(data.queues.map((q) => q.name));

  // Decide whether to render GPU axis in MiB→GiB or in slot counts.
  // Prefer "MiB" mode if EITHER a queue declared vgpu-memory OR the
  // cluster Nodes advertise it (the latter catches the common case
  // of no admin-set capability — pre-fix this returned `count` mode
  // and the GPU row showed 0 / 0).
  const clusterCap = data.clusterAllocatable ?? {};
  const hasVgpuMemory =
    data.queues.some(
      (q) =>
        q.capability?.['volcano.sh/vgpu-memory'] ||
        q.allocated?.['volcano.sh/vgpu-memory'],
    ) || !!clusterCap['volcano.sh/vgpu-memory'];

  // pick = explicit Queue cap when set, else fall back to cluster
  // physical Allocatable for the same resource. Mirrors what
  // ResourceQuotaRow does in QueueQuota.tsx — keeps the headline
  // gauge and the per-queue bars consistent.
  const pick = (qVal: string | undefined, clusterKey: string): number => {
    const q = parseQuantity(qVal);
    if (q > 0) return q;
    return parseQuantity(clusterCap[clusterKey]);
  };

  let cpuT = 0,
    cpuA = 0,
    memT = 0,
    memA = 0,
    gpuT = 0,
    gpuA = 0,
    hasGpu = false;
  for (const q of data.queues) {
    if (q.parent && names.has(q.parent)) continue;
    cpuT += pick(q.capability?.cpu, 'cpu');
    cpuA += parseQuantity(q.allocated?.cpu);
    memT += pick(q.capability?.memory, 'memory');
    memA += parseQuantity(q.allocated?.memory);
    if (hasVgpuMemory) {
      // Volcano stores vgpu-memory as a unit-less integer in MiB;
      // /1024 to keep the GPU row's numbers in GiB like the memory
      // row above.
      gpuT +=
        pick(
          q.capability?.['volcano.sh/vgpu-memory'],
          'volcano.sh/vgpu-memory',
        ) / 1024;
      gpuA += parseQuantity(q.allocated?.['volcano.sh/vgpu-memory']) / 1024;
    } else {
      gpuT +=
        pick(
          q.capability?.['volcano.sh/vgpu-number'],
          'volcano.sh/vgpu-number',
        ) + pick(q.capability?.['nvidia.com/gpu'], 'nvidia.com/gpu');
      gpuA +=
        parseQuantity(q.allocated?.['volcano.sh/vgpu-number']) +
        parseQuantity(q.allocated?.['nvidia.com/gpu']);
    }
    if (
      q.capability?.['volcano.sh/vgpu-number'] ||
      q.capability?.['volcano.sh/vgpu-memory'] ||
      q.capability?.['nvidia.com/gpu'] ||
      q.allocated?.['volcano.sh/vgpu-number'] ||
      q.allocated?.['volcano.sh/vgpu-memory'] ||
      q.allocated?.['nvidia.com/gpu'] ||
      clusterCap['volcano.sh/vgpu-number'] ||
      clusterCap['volcano.sh/vgpu-memory'] ||
      clusterCap['nvidia.com/gpu']
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
    gpuUnit: hasVgpuMemory ? 'GiB' : 'count',
    hasGpu,
  };
}

// ─── Queue resource usage (queue × resource table) ────────────────────

interface QueueResourceRow {
  name: string;
  cpu: { allocated: number; total: number };
  memory: { allocated: number; total: number }; // GiB
  gpu: { allocated: number; total: number };
  // Pre-computed for sorting. `maxUtil` is the highest utilization
  // across resource types when *any* resource is bounded — that
  // queue can hit a cap, so it sorts by pressure. `unboundedLoad` is
  // a synthetic score for fully-unbounded queues (no caps anywhere);
  // they're ranked by absolute consumption so the largest still
  // surfaces above the idle ones.
  maxUtil: number;
  fullyUnbounded: boolean;
  unboundedLoad: number;
}

function QueueResourceCard({ data }: { data: BundleData }) {
  const intl = useIntl();
  // Build one row per queue with cpu/mem/gpu allocated + total.
  // The earlier stacked-facet Column chart became hard to read on
  // realistic clusters (10+ queues × 3-4 facets = a wall of narrow
  // bars on three different y scales). The table form gives every
  // queue one row and every resource its own mini utilization bar,
  // so "which queue × which resource is hot" is a single eye scan.
  // Same vGPU-memory-preferred mode detection as the cluster
  // capacity card: if any queue declared vgpu-memory OR the cluster
  // Nodes advertise it, we render GPU as memory (GiB) rather than
  // slot/card counts.
  const clusterCap = data.clusterAllocatable ?? {};
  const hasVgpuMemory = useMemo(
    () =>
      data.queues.some(
        (q) =>
          q.capability?.['volcano.sh/vgpu-memory'] ||
          q.allocated?.['volcano.sh/vgpu-memory'],
      ) || !!clusterCap['volcano.sh/vgpu-memory'],
    [data.queues, clusterCap],
  );

  const { rows, hasGpu } = useMemo(() => {
    let _hasGpu = false;
    const out: QueueResourceRow[] = [];
    // pick = explicit Queue cap when set, else fall back to the
    // cluster physical Allocatable for the same resource. Mirrors
    // clusterCapacity() above + the QueueQuota page's row logic so
    // every "what's my cap" surface tells the same story.
    const pick = (qVal: string | undefined, clusterKey: string): number => {
      const q = parseQuantity(qVal);
      if (q > 0) return q;
      return parseQuantity(clusterCap[clusterKey]);
    };
    for (const q of data.queues) {
      const cpuAlloc = parseQuantity(q.allocated?.cpu);
      const cpuCap = pick(q.capability?.cpu, 'cpu');
      const memAlloc = parseQuantity(q.allocated?.memory) / 1024 ** 3;
      const memCap = pick(q.capability?.memory, 'memory') / 1024 ** 3;
      // GPU axis: memory (GiB) when vGPU-memory mode is active,
      // otherwise slot/card counts. Same detection as
      // clusterCapacity() so the cluster card and the per-queue
      // table tell the same story.
      let gpuAlloc: number;
      let gpuCap: number;
      if (hasVgpuMemory) {
        gpuAlloc =
          parseQuantity(q.allocated?.['volcano.sh/vgpu-memory']) / 1024;
        gpuCap =
          pick(
            q.capability?.['volcano.sh/vgpu-memory'],
            'volcano.sh/vgpu-memory',
          ) / 1024;
      } else {
        gpuAlloc =
          parseQuantity(q.allocated?.['volcano.sh/vgpu-number']) +
          parseQuantity(q.allocated?.['nvidia.com/gpu']);
        gpuCap =
          pick(
            q.capability?.['volcano.sh/vgpu-number'],
            'volcano.sh/vgpu-number',
          ) + pick(q.capability?.['nvidia.com/gpu'], 'nvidia.com/gpu');
      }
      if (gpuAlloc > 0 || gpuCap > 0) _hasGpu = true;
      const u = (a: number, t: number) => (t > 0 ? a / t : 0);
      const maxUtil = Math.max(
        u(cpuAlloc, cpuCap),
        u(memAlloc, memCap),
        u(gpuAlloc, gpuCap),
      );
      // Fully unbounded = no capability AND no cluster fallback on
      // any resource. With the cluster-Allocatable fallback in
      // place this branch is now rare (most clusters always have
      // some Node resource a queue could consume), but keep the
      // ordering logic for the truly resource-less case.
      const fullyUnbounded = cpuCap <= 0 && memCap <= 0 && gpuCap <= 0;
      const unboundedLoad = cpuAlloc + memAlloc + gpuAlloc;
      out.push({
        name: q.name,
        cpu: { allocated: cpuAlloc, total: cpuCap },
        memory: { allocated: memAlloc, total: memCap },
        gpu: { allocated: gpuAlloc, total: gpuCap },
        maxUtil,
        fullyUnbounded,
        unboundedLoad,
      });
    }
    // Sort: bounded queues first (by utilization desc — who's
    // closest to their cap), then fully-unbounded queues (by raw
    // consumption desc — who's eating the most). Name tie-breaks
    // within each block for stable rendering.
    out.sort((a, b) => {
      if (a.fullyUnbounded !== b.fullyUnbounded) {
        return a.fullyUnbounded ? 1 : -1;
      }
      if (a.fullyUnbounded) {
        return (
          b.unboundedLoad - a.unboundedLoad || a.name.localeCompare(b.name)
        );
      }
      return b.maxUtil - a.maxUtil || a.name.localeCompare(b.name);
    });
    return { rows: out, hasGpu: _hasGpu };
  }, [data.queues, hasVgpuMemory, clusterCap]);

  // Grid columns: queue (160px) + N resource columns (1fr each).
  const cols = hasGpu ? '160px 1fr 1fr 1fr' : '160px 1fr 1fr';

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
      styles={{
        body: { padding: '8px 16px 12px', maxHeight: 420, overflow: 'auto' },
      }}
    >
      {rows.length === 0 ? (
        <EmptyHint id="pages.compute.overview.queues.empty" />
      ) : (
        <div>
          {/* Header — same grid as data rows so columns align. */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: cols,
              gap: 16,
              padding: '6px 0',
              fontSize: 12,
              color: 'var(--ant-color-text-tertiary)',
              borderBottom: '1px solid var(--ant-color-split)',
            }}
          >
            <div>
              {intl.formatMessage({
                id: 'pages.compute.overview.queues.col.queue',
              })}
            </div>
            <div>
              {intl.formatMessage({ id: 'pages.compute.overview.gauge.cpu' })}
            </div>
            <div>
              {intl.formatMessage({
                id: 'pages.compute.overview.gauge.memory',
              })}
            </div>
            {hasGpu && (
              <div>
                {intl.formatMessage({
                  id: 'pages.compute.overview.gauge.gpu',
                })}
              </div>
            )}
          </div>
          {rows.map((r) => (
            <div
              key={r.name}
              style={{
                display: 'grid',
                gridTemplateColumns: cols,
                gap: 16,
                alignItems: 'center',
                padding: '8px 0',
                borderBottom: '1px solid var(--ant-color-split)',
              }}
            >
              <Text
                strong
                style={{ fontSize: 13 }}
                ellipsis={{ tooltip: r.name }}
              >
                {r.name}
              </Text>
              <UtilCell
                allocated={r.cpu.allocated}
                total={r.cpu.total}
                unit=""
              />
              <UtilCell
                allocated={r.memory.allocated}
                total={r.memory.total}
                unit="GiB"
              />
              {hasGpu && (
                <UtilCell
                  allocated={r.gpu.allocated}
                  total={r.gpu.total}
                  unit={hasVgpuMemory ? 'GiB' : ''}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// UtilCell is one cell of the queue × resource table: thin
// utilization bar + "X / Y unit" + percentage + warning glyph at
// ≥85%. Renders an em-dash when the queue didn't declare capability
// for this resource (so the row stays aligned across queues).
function UtilCell({
  allocated,
  total,
  unit,
}: {
  allocated: number;
  total: number;
  unit: string;
}) {
  const { token } = theme.useToken();
  if (total <= 0 && allocated <= 0) {
    return (
      <span style={{ color: 'var(--ant-color-text-quaternary)', fontSize: 13 }}>
        —
      </span>
    );
  }
  const unbounded = total <= 0;
  const pct = unbounded ? 0 : Math.min(allocated / total, 1);
  const color = usageColor(pct, token);
  const overloaded = pct >= 0.85;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 40,
          height: 8,
          // Unbounded queues get a faint diagonal-stripe track so the
          // empty bar doesn't read as "0% used" (which was the bug
          // root with allocated=1 / capability=∞ surfaced). Bounded
          // queues keep the solid neutral track.
          background: unbounded
            ? 'repeating-linear-gradient(45deg, var(--ant-color-fill-tertiary) 0 4px, transparent 4px 8px)'
            : 'var(--ant-color-fill-tertiary)',
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        {!unbounded && (
          <div
            style={{
              width: `${pct * 100}%`,
              height: '100%',
              background: color,
            }}
          />
        )}
      </div>
      <div
        style={{
          fontSize: 12,
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--ant-color-text-secondary)',
          whiteSpace: 'nowrap',
        }}
      >
        {unbounded ? (
          // X/∞ reads as "X out of unlimited" — same shape as the
          // bounded "X/Y" so the row alignment + scanning rhythm is
          // preserved, and it can't be mistaken for "limit = X".
          <>
            {formatNum(allocated)}/∞{unit ? ` ${unit}` : ''}
          </>
        ) : (
          <>
            {formatNum(allocated)}/{formatNum(total)}
            {unit ? ` ${unit}` : ''}{' '}
            <span style={{ color, fontWeight: 600, marginInlineStart: 2 }}>
              {(pct * 100).toFixed(0)}%
            </span>
          </>
        )}
      </div>
      {overloaded && (
        <ExclamationCircleFilled
          style={{ color: token.colorError, fontSize: 12, flexShrink: 0 }}
        />
      )}
    </div>
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
  memAlloc: number; // GiB
  memCap: number; // GiB
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
        cpuAlloc: parseQuantity(q.allocated?.cpu),
        cpuCap: parseQuantity(q.capability?.cpu),
        memAlloc: parseQuantity(q.allocated?.memory) / 1024 ** 3,
        memCap: parseQuantity(q.capability?.memory) / 1024 ** 3,
        children: [],
      });
    }
    const roots: QueueNodeBuild[] = [];
    let nested = false;
    for (const node of byName.values()) {
      if (node.parent && byName.has(node.parent)) {
        byName.get(node.parent)?.children.push(node);
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
      <ResourceChip
        name="cpu"
        allocated={node.cpuAlloc}
        total={node.cpuCap}
        unit=""
      />
      <ResourceChip
        name="mem"
        allocated={node.memAlloc}
        total={node.memCap}
        unit="Gi"
      />
    </Space>
  );
}

// ResourceChip — one inline "cpu 1/4 · 25%" pill. Bounded gets a
// utilization-colored ratio; unbounded gets a `/∞` denominator so
// it never reads as "limit equals allocated". Hidden when the queue
// hasn't reported either allocated or capability for the resource.
function ResourceChip({
  name,
  allocated,
  total,
  unit,
}: {
  name: string;
  allocated: number;
  total: number;
  unit: string;
}) {
  if (total <= 0 && allocated <= 0) return null;
  const unbounded = total <= 0;
  const ratio = unbounded ? 0 : Math.min(allocated / total, 1);
  const color =
    ratio >= 0.85
      ? 'var(--ant-color-error)'
      : ratio >= 0.6
        ? 'var(--ant-color-warning)'
        : 'var(--ant-color-text-tertiary)';
  return (
    <Text style={{ fontSize: 12, color, fontVariantNumeric: 'tabular-nums' }}>
      {name} {formatNum(allocated)}/{unbounded ? '∞' : formatNum(total)}
      {unit ? unit : ''}
      {!unbounded && ` · ${(ratio * 100).toFixed(0)}%`}
    </Text>
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

// parseQuantity lives in shared/utils.ts so QueueQuota can reuse it.
