import { Column, Gauge, Pie, Sunburst } from '@ant-design/plots';
import { useIntl } from '@umijs/max';
import { Card, Col, Empty, Row, Statistic, Tag, Typography } from 'antd';
import React, { useMemo } from 'react';

import type { BundleData } from './Overview';

const { Text } = Typography;

// OverviewCharts holds all the heavy @ant-design/plots renders.
// Lazy-imported from Overview.tsx so the G2 runtime only ships on
// dashboard open. Parent fetches everything once and passes the
// bundle here; each chart card derives its own shape with useMemo.

export default function OverviewCharts({ data }: { data: BundleData }) {
  const cluster = useMemo(() => clusterCapacity(data), [data]);
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
        <Col xs={24} md={12} lg={8}>
          <JobPhaseCard data={data} />
        </Col>
        <Col xs={24} md={12} lg={8}>
          <PodGroupPhaseCard data={data} />
        </Col>
        <Col xs={24} md={24} lg={8}>
          <JobFlowPhaseCard data={data} />
        </Col>
        <Col xs={24}>
          <JobByQueueCard data={data} />
        </Col>
        <Col xs={24} lg={12}>
          <QueueHierarchyCard data={data} />
        </Col>
        <Col xs={24} lg={12}>
          <CronJobStateCard data={data} />
        </Col>
        <Col xs={24}>
          <HyperNodeTierCard data={data} />
        </Col>
      </Row>
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
  const color =
    pct >= 0.85 ? '#ff4d4f' : pct >= 0.6 ? '#faad14' : '#52c41a';
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
            {unit ? <span style={{ fontSize: 14, marginInlineStart: 4 }}>{unit}</span> : null}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ant-color-text-tertiary)' }}>
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
    const out: { queue: string; metric: string; value: number; kind: string }[] = [];
    for (const q of data.queues) {
      const cpuCap = parseQuantity(q.capability?.['cpu']);
      const cpuAlloc = parseQuantity(q.allocated?.['cpu']);
      const memCap = parseQuantity(q.capability?.['memory']);
      const memAlloc = parseQuantity(q.allocated?.['memory']);
      out.push(
        { queue: q.name, metric: 'cpu (cores)', value: cpuAlloc, kind: 'allocated' },
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
          { queue: q.name, metric: 'vgpu', value: vgpuAlloc, kind: 'allocated' },
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
            color: { domain: ['allocated', 'free'], range: ['#1677ff', '#d9d9d9'] },
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

// ─── Job phase pie ────────────────────────────────────────────────────

const JOB_STATE_COLORS: Record<string, string> = {
  Running: '#52c41a',
  Completed: '#1677ff',
  Completing: '#1677ff',
  Pending: '#faad14',
  Failed: '#ff4d4f',
  Terminated: '#ff4d4f',
  Aborted: '#ff4d4f',
  Restarting: '#fa8c16',
  Terminating: '#fa8c16',
  Aborting: '#fa8c16',
};

function JobPhaseCard({ data }: { data: BundleData }) {
  const intl = useIntl();
  const rows = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const j of data.jobs) {
      const k = j.state || 'Unknown';
      counts[k] = (counts[k] ?? 0) + 1;
    }
    return Object.entries(counts).map(([state, count]) => ({ state, count }));
  }, [data.jobs]);
  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={intl.formatMessage({ id: 'pages.compute.overview.jobs.title' })}
      extra={
        <Text type="secondary" style={{ fontSize: 12 }}>
          {intl.formatMessage(
            { id: 'pages.compute.overview.jobs.subtitle' },
            { n: data.jobs.length },
          )}
        </Text>
      }
    >
      {rows.length === 0 ? (
        <EmptyHint id="pages.compute.overview.jobs.empty" />
      ) : (
        <Pie
          height={280}
          data={rows}
          angleField="count"
          colorField="state"
          innerRadius={0.55}
          label={{ text: 'count', position: 'spider', style: { fontSize: 12 } }}
          scale={{
            color: {
              domain: Object.keys(JOB_STATE_COLORS),
              range: Object.values(JOB_STATE_COLORS),
            },
          }}
          legend={{ color: { position: 'right' } }}
          tooltip={{
            title: (d: any) => d.state,
            items: [{ field: 'count', name: 'jobs' }],
          }}
        />
      )}
    </Card>
  );
}

// ─── PodGroup phase pie ───────────────────────────────────────────────

const PG_PHASE_COLORS: Record<string, string> = {
  Running: '#52c41a',
  Completed: '#1677ff',
  Pending: '#faad14',
  Inqueue: '#13c2c2',
  Failed: '#ff4d4f',
  Unknown: '#fa8c16',
};

function PodGroupPhaseCard({ data }: { data: BundleData }) {
  const intl = useIntl();
  const rows = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of data.podGroups) {
      const k = p.phase || 'Unknown';
      counts[k] = (counts[k] ?? 0) + 1;
    }
    return Object.entries(counts).map(([phase, count]) => ({ phase, count }));
  }, [data.podGroups]);
  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={intl.formatMessage({
        id: 'pages.compute.overview.podgroups.title',
      })}
      extra={
        <Text type="secondary" style={{ fontSize: 12 }}>
          {intl.formatMessage(
            { id: 'pages.compute.overview.podgroups.subtitle' },
            { n: data.podGroups.length },
          )}
        </Text>
      }
    >
      {rows.length === 0 ? (
        <EmptyHint id="pages.compute.overview.podgroups.empty" />
      ) : (
        <Pie
          height={280}
          data={rows}
          angleField="count"
          colorField="phase"
          innerRadius={0.55}
          label={{ text: 'count', position: 'spider', style: { fontSize: 12 } }}
          scale={{
            color: {
              domain: Object.keys(PG_PHASE_COLORS),
              range: Object.values(PG_PHASE_COLORS),
            },
          }}
          legend={{ color: { position: 'right' } }}
          tooltip={{
            title: (d: any) => d.phase,
            items: [{ field: 'count', name: 'PodGroups' }],
          }}
        />
      )}
    </Card>
  );
}

// ─── JobFlow phase pie ────────────────────────────────────────────────

const JOBFLOW_PHASE_COLORS: Record<string, string> = {
  Succeed: '#52c41a',
  Running: '#52c41a',
  Pending: '#faad14',
  Failed: '#ff4d4f',
  Terminating: '#fa8c16',
  '': '#bfbfbf', // Volcano leaves the phase blank when controller hasn't reconciled yet
};

function JobFlowPhaseCard({ data }: { data: BundleData }) {
  const intl = useIntl();
  const rows = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const j of data.jobFlows) {
      const k = j.phase || 'Unknown';
      counts[k] = (counts[k] ?? 0) + 1;
    }
    return Object.entries(counts).map(([phase, count]) => ({ phase, count }));
  }, [data.jobFlows]);
  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={intl.formatMessage({
        id: 'pages.compute.overview.jobflows.title',
      })}
      extra={
        <Text type="secondary" style={{ fontSize: 12 }}>
          {intl.formatMessage(
            { id: 'pages.compute.overview.jobflows.subtitle' },
            { n: data.jobFlows.length },
          )}
        </Text>
      }
    >
      {rows.length === 0 ? (
        <EmptyHint id="pages.compute.overview.jobflows.empty" />
      ) : (
        <Pie
          height={280}
          data={rows}
          angleField="count"
          colorField="phase"
          innerRadius={0.55}
          label={{ text: 'count', position: 'spider', style: { fontSize: 12 } }}
          scale={{
            color: {
              domain: Object.keys(JOBFLOW_PHASE_COLORS),
              range: Object.values(JOBFLOW_PHASE_COLORS),
            },
          }}
          legend={{ color: { position: 'right' } }}
          tooltip={{
            title: (d: any) => d.phase || 'Unknown',
            items: [{ field: 'count', name: 'JobFlows' }],
          }}
        />
      )}
    </Card>
  );
}

// ─── Job × Queue matrix ───────────────────────────────────────────────

function JobByQueueCard({ data }: { data: BundleData }) {
  const intl = useIntl();
  // Group by (queue, state) -> count. Surfaces which queues are
  // hot or accumulating failures. Stacked column with same color
  // map as Job phase pie so the user can mentally cross-reference.
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
              domain: Object.keys(JOB_STATE_COLORS),
              range: Object.values(JOB_STATE_COLORS),
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

// ─── Queue hierarchy sunburst ─────────────────────────────────────────

interface SunburstNode {
  name: string;
  value?: number;
  children?: SunburstNode[];
}

function QueueHierarchyCard({ data }: { data: BundleData }) {
  const intl = useIntl();
  // Build the queue parent tree. Use cpu capability (cores) as the
  // ring weight — clearest signal of capacity carve-up. Queues
  // without a capability default to 1 so they still appear (sunburst
  // ignores zero-weight leaves).
  const tree = useMemo<SunburstNode | null>(() => {
    if (data.queues.length === 0) return null;
    const byName = new Map<string, QueueNodeBuild>();
    for (const q of data.queues) {
      const cpu = parseQuantity(q.capability?.['cpu']);
      byName.set(q.name, {
        name: q.name,
        parent: q.parent || undefined,
        value: cpu > 0 ? cpu : 1,
        children: [],
      });
    }
    const roots: QueueNodeBuild[] = [];
    for (const node of byName.values()) {
      if (node.parent && byName.has(node.parent)) {
        byName.get(node.parent)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    if (roots.length === 0) return null;
    const toSunburst = (n: QueueNodeBuild): SunburstNode => ({
      name: n.name,
      value: n.children.length === 0 ? n.value : undefined,
      children: n.children.length > 0 ? n.children.map(toSunburst) : undefined,
    });
    // Wrap in a synthetic root so multiple top-level queues render
    // as a single sunburst (single root means user sees the whole
    // landscape in one chart).
    return {
      name: 'queues',
      children: roots.map(toSunburst),
    };
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
          {intl.formatMessage({
            id: 'pages.compute.overview.hierarchy.subtitle',
          })}
        </Text>
      }
    >
      {!tree ? (
        <EmptyHint id="pages.compute.overview.hierarchy.empty" />
      ) : (
        <Sunburst
          height={300}
          data={tree as any}
          valueField="value"
          colorField="name"
          legend={false}
          label={{ text: 'name', style: { fontSize: 12 } }}
          tooltip={{
            title: (d: any) => d.name,
            items: [
              {
                field: 'value',
                name: 'cpu (cores)',
                valueFormatter: (v: number) => v?.toFixed(2) ?? '-',
              },
            ],
          }}
        />
      )}
    </Card>
  );
}

interface QueueNodeBuild {
  name: string;
  parent?: string;
  value: number;
  children: QueueNodeBuild[];
}

// ─── CronJob state ────────────────────────────────────────────────────

function CronJobStateCard({ data }: { data: BundleData }) {
  const intl = useIntl();
  const total = data.cronJobs.length;
  const suspended = data.cronJobs.filter((c) => c.suspend).length;
  const active = total - suspended;
  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={intl.formatMessage({
        id: 'pages.compute.overview.cronjobs.title',
      })}
      extra={
        <Text type="secondary" style={{ fontSize: 12 }}>
          {intl.formatMessage(
            { id: 'pages.compute.overview.cronjobs.subtitle' },
            { n: total },
          )}
        </Text>
      }
    >
      {total === 0 ? (
        <EmptyHint id="pages.compute.overview.cronjobs.empty" />
      ) : (
        <Row gutter={12} style={{ minHeight: 260, alignItems: 'center' }}>
          <Col span={12}>
            <Statistic
              title={intl.formatMessage({
                id: 'pages.compute.overview.cronjobs.active',
              })}
              value={active}
              valueStyle={{ color: 'var(--ant-color-success)', fontSize: 32 }}
            />
          </Col>
          <Col span={12}>
            <Statistic
              title={intl.formatMessage({
                id: 'pages.compute.overview.cronjobs.suspended',
              })}
              value={suspended}
              valueStyle={{
                color:
                  suspended > 0
                    ? 'var(--ant-color-warning)'
                    : 'var(--ant-color-text-tertiary)',
                fontSize: 32,
              }}
            />
          </Col>
        </Row>
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
      {rows.length === 0 ? (
        <EmptyHint id="pages.compute.overview.hypernodes.empty" />
      ) : (
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
      )}
    </Card>
  );
}

function EmptyHint({ id }: { id: string }) {
  const intl = useIntl();
  return (
    <div
      style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
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
