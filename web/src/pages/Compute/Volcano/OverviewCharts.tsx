import { Column, Pie } from '@ant-design/plots';
import { useIntl } from '@umijs/max';
import { Card, Col, Empty, Row, Statistic, Typography } from 'antd';
import React, { useMemo } from 'react';

import type { BundleData } from './Overview';

const { Text } = Typography;

// OverviewCharts owns the heavy @ant-design/plots imports — kept in
// a separate file so React.lazy can code-split it. The parent page
// fetches data once and forwards the bundle here.

export default function OverviewCharts({ data }: { data: BundleData }) {
  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} lg={12}>
        <QueueResourceCard data={data} />
      </Col>
      <Col xs={24} lg={12}>
        <JobPhaseCard data={data} />
      </Col>
      <Col xs={24} lg={12}>
        <PodGroupPhaseCard data={data} />
      </Col>
      <Col xs={24} lg={12}>
        <CronJobStateCard data={data} />
      </Col>
      <Col xs={24}>
        <HyperNodeTierCard data={data} />
      </Col>
    </Row>
  );
}

// ─── Queue resources ───────────────────────────────────────────────────

// Stacked grouped column: per-queue allocated vs capability for cpu /
// memory. Two queues × {cpu, memory} = 4 series per row. Quantity
// parsing is best-effort — we strip K8s unit suffixes the way kubectl
// does for the simple cases (Gi / Mi / Ki / m for cpu millicores).
// Charts are illustrative so we don't need to handle every edge case
// the apimachinery parser does.
function QueueResourceCard({ data }: { data: BundleData }) {
  const intl = useIntl();
  const rows = useMemo(() => {
    const out: { queue: string; metric: string; value: number; kind: string }[] = [];
    for (const q of data.queues) {
      // For each queue produce 4 bars: cpu allocated/capability, memory allocated/capability.
      const cpuCap = parseQuantity(q.capability?.['cpu']);
      const cpuAlloc = parseQuantity(q.allocated?.['cpu']);
      const memCap = parseQuantity(q.capability?.['memory']);
      const memAlloc = parseQuantity(q.allocated?.['memory']);
      out.push({
        queue: q.name,
        metric: 'cpu (cores)',
        value: cpuAlloc,
        kind: 'allocated',
      });
      out.push({
        queue: q.name,
        metric: 'cpu (cores)',
        value: Math.max(cpuCap - cpuAlloc, 0),
        kind: 'free',
      });
      out.push({
        queue: q.name,
        metric: 'memory (GiB)',
        value: memAlloc / (1024 * 1024 * 1024),
        kind: 'allocated',
      });
      out.push({
        queue: q.name,
        metric: 'memory (GiB)',
        value: Math.max((memCap - memAlloc) / (1024 * 1024 * 1024), 0),
        kind: 'free',
      });
    }
    return out;
  }, [data.queues]);

  return (
    <Card
      size="small"
      title={intl.formatMessage({
        id: 'pages.compute.overview.queues.title',
      })}
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
          height={300}
          data={rows}
          xField="queue"
          yField="value"
          colorField="kind"
          stack
          group
          // axis label rotated so longer queue names don't overlap.
          axis={{
            x: { labelAutoRotate: true },
            y: { title: false },
          }}
          legend={{ color: { position: 'top' } }}
          // Separate panel per resource metric (cpu vs memory).
          facet={{ type: 'rect', fields: ['metric'] }}
          // Color map: green for free, blue for allocated.
          scale={{
            color: {
              domain: ['allocated', 'free'],
              range: ['#1677ff', '#d9d9d9'],
            },
          }}
          tooltip={(d: any) =>
            `${d.queue} · ${d.kind}: ${d.value.toFixed(2)}`
          }
        />
      )}
    </Card>
  );
}

// ─── Job phase pie ─────────────────────────────────────────────────────

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
      title={intl.formatMessage({
        id: 'pages.compute.overview.jobs.title',
      })}
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
          height={300}
          data={rows}
          angleField="count"
          colorField="state"
          innerRadius={0.55}
          label={{
            text: 'count',
            position: 'spider',
            style: { fontSize: 12 },
          }}
          scale={{
            color: {
              domain: Object.keys(JOB_STATE_COLORS),
              range: Object.values(JOB_STATE_COLORS),
            },
          }}
          legend={{ color: { position: 'right' } }}
        />
      )}
    </Card>
  );
}

// ─── PodGroup phase pie ────────────────────────────────────────────────

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
          height={300}
          data={rows}
          angleField="count"
          colorField="phase"
          innerRadius={0.55}
          label={{
            text: 'count',
            position: 'spider',
            style: { fontSize: 12 },
          }}
          scale={{
            color: {
              domain: Object.keys(PG_PHASE_COLORS),
              range: Object.values(PG_PHASE_COLORS),
            },
          }}
          legend={{ color: { position: 'right' } }}
        />
      )}
    </Card>
  );
}

// ─── CronJob suspend split ────────────────────────────────────────────

// CronJob isn't worth a pie at typical sizes (usually 1-3) so render
// it as two side-by-side stat cards — easier to scan.
function CronJobStateCard({ data }: { data: BundleData }) {
  const intl = useIntl();
  const total = data.cronJobs.length;
  const suspended = data.cronJobs.filter((c) => c.suspend).length;
  const active = total - suspended;

  return (
    <Card
      size="small"
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
        <Row gutter={12} style={{ minHeight: 300, alignItems: 'center' }}>
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

// parseQuantity does a best-effort K8s Quantity → number translation
// for the units the dashboard cares about. cpu cores (handles `m`
// suffix for millicores) and memory in raw bytes (handles Ki/Mi/Gi/
// Ti binary prefixes plus K/M/G/T decimal). Anything we can't parse
// returns 0 — these charts are illustrative, not balance-sheet exact.
function parseQuantity(raw: string | undefined): number {
  if (!raw) return 0;
  const s = raw.trim();
  if (!s) return 0;
  // millicores
  if (s.endsWith('m')) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n / 1000 : 0;
  }
  // Binary prefixes (case-sensitive — K8s convention).
  const binPrefixes: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 * 1024,
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
  // Decimal SI prefixes.
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
