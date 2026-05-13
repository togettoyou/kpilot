import { ArrowRightOutlined, ReloadOutlined } from '@ant-design/icons';
import { history, useIntl, useModel, useParams, useRequest } from '@umijs/max';
import {
  Button,
  Card,
  Col,
  Empty,
  List,
  Row,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import yaml from 'js-yaml';
import React, { lazy, Suspense, useMemo } from 'react';

import { listClusterPlugins } from '@/services/kpilot/plugin';
import {
  listVolcanoCronJobs,
  listVolcanoHyperNodes,
  listVolcanoJobFlows,
  listVolcanoJobs,
  listVolcanoPodGroups,
  listVolcanoQueues,
  type CronJobRow,
  type HyperNodeRow,
  type JobFlowRow,
  type JobRow,
  type PodGroupRow,
  type QueueRow,
} from '@/services/kpilot/volcano-list';
import { getWorkload } from '@/services/kpilot/workload';
import {
  NotInstalled,
  RefreshControl,
  formatAge,
  isResourceNotAvailable,
  useAutoRefresh,
} from './shared/Layout';

const { Text } = Typography;

// Overview = Volcano dashboard. Aggregates six list endpoints +
// scheduler configmap in a single fetch and projects them onto KPIs,
// gauges, charts, and operational lists. The chart-heavy half is
// lazy-loaded so the dashboard's @ant-design/plots G2 runtime
// (~250 KB gzip) only ships when this page is actually opened.
const Charts = lazy(() => import('./OverviewCharts'));

export interface SchedulerConfSummary {
  actions: string[];
  // Per-tier list of plugin names. Index = tier number minus 1.
  tiers: string[][];
}

export interface BundleData {
  queues: QueueRow[];
  jobs: JobRow[];
  cronJobs: CronJobRow[];
  podGroups: PodGroupRow[];
  hyperNodes: HyperNodeRow[];
  jobFlows: JobFlowRow[];
  // Scheduler config summary; null if Volcano plugin entry not yet
  // ready or configmap missing — banner is hidden in that case.
  scheduler: SchedulerConfSummary | null;
  // True if any list endpoint hit the server-side 500-row cap.
  truncated: boolean;
}

export default function VolcanoOverviewPage() {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const namespaceModel = useModel('namespace');
  const ns = clusterId ? namespaceModel.get(clusterId).selected : '';

  const { data, loading, error, refresh } = useRequest(
    async (): Promise<BundleData> => {
      const [queues, jobs, cronJobs, podGroups, hyperNodes, jobFlows] =
        await Promise.all([
          listVolcanoQueues(clusterId!),
          listVolcanoJobs(clusterId!, ns),
          listVolcanoCronJobs(clusterId!, ns),
          listVolcanoPodGroups(clusterId!, ns),
          listVolcanoHyperNodes(clusterId!),
          listVolcanoJobFlows(clusterId!, ns),
        ]);
      // Scheduler config summary — best-effort. Race conditions
      // around a fresh Volcano install can produce 404s here; we
      // tolerate them silently rather than break the whole page.
      let scheduler: SchedulerConfSummary | null = null;
      try {
        const plugins = await listClusterPlugins(clusterId!);
        const volcano = plugins?.find((p) => p.plugin.name === 'volcano');
        const ns =
          volcano?.plugin?.default_release_namespace ?? 'kpilot-scheduling';
        const cm = (await getWorkload(
          clusterId!,
          'configmaps',
          'volcano-scheduler-configmap',
          ns,
        )) as any;
        const raw =
          cm?.data?.['volcano-scheduler.conf'] ??
          cm?.data?.['volcano-scheduler.yaml'] ??
          '';
        if (typeof raw === 'string' && raw.trim()) {
          const parsed = yaml.load(raw) as any;
          const actions = (parsed?.actions ?? '')
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean);
          const tiers: string[][] = ((parsed?.tiers ?? []) as any[]).map(
            (t: any) =>
              (t?.plugins ?? [])
                .map((p: any) => p?.name)
                .filter((n: any): n is string => !!n),
          );
          scheduler = { actions, tiers };
        }
      } catch {
        // ignore — scheduler card just won't render
      }
      return {
        queues: queues.items ?? [],
        jobs: jobs.items ?? [],
        cronJobs: cronJobs.items ?? [],
        podGroups: podGroups.items ?? [],
        hyperNodes: hyperNodes.items ?? [],
        jobFlows: jobFlows.items ?? [],
        scheduler,
        truncated: !!(
          queues.continue ||
          jobs.continue ||
          cronJobs.continue ||
          podGroups.continue ||
          hyperNodes.continue ||
          jobFlows.continue
        ),
      };
    },
    {
      formatResult: (res) => res,
      ready: !!clusterId,
      refreshDeps: [clusterId, ns],
    },
  );

  const [interval, setInterval] = useAutoRefresh(refresh, !!clusterId);

  const kpis = useMemo(() => buildKpis(data), [data]);
  const failedJobs = useMemo(() => topFailedJobs(data, 5), [data]);
  const recentJobs = useMemo(() => topRecentJobs(data, 5), [data]);

  if (!clusterId) return null;
  if (error && isResourceNotAvailable(error)) {
    return <NotInstalled clusterId={clusterId} />;
  }

  const ready = !!data;

  return (
    <div style={{ padding: 16 }}>
      <Space style={{ marginBottom: 12 }} align="center" wrap>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          {intl.formatMessage({ id: 'pages.compute.overview.title' })}
        </h2>
        <Tag color="blue">{ns ? `ns=${ns}` : 'all namespaces'}</Tag>
        <RefreshControl
          interval={interval}
          setInterval={setInterval}
          refresh={refresh}
          loading={loading}
        />
        {data?.truncated && (
          <Tag color="orange">
            {intl.formatMessage({
              id: 'pages.compute.overview.truncated',
            })}
          </Tag>
        )}
      </Space>

      {/* KPI row first — quick scan of totals. 8 cards at lg+, fewer per row on smaller widths. */}
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }} align="stretch">
        {kpis.map((k) => {
          const toneColor =
            k.tone === 'warn'
              ? 'var(--ant-color-warning)'
              : k.tone === 'error'
                ? 'var(--ant-color-error)'
                : k.tone === 'ok'
                  ? 'var(--ant-color-success)'
                  : undefined;
          return (
            <Col key={k.key} xs={12} sm={8} md={6} lg={3} xl={3}>
              <Card
                size="small"
                loading={loading && !ready}
                style={{ height: '100%' }}
                styles={{ body: { padding: '12px 16px' } }}
              >
                {/* Custom layout instead of antd Statistic so number /
                    string / duration values all flow through the same
                    rendering path (Statistic uses a CountAnimation for
                    numeric values that subtly shifts the baseline vs
                    plain strings; this kept the 8 KPI value lines from
                    aligning across the row). */}
                <div
                  style={{
                    fontSize: 14,
                    color: 'var(--ant-color-text-secondary)',
                    lineHeight: 1.4,
                    // Reserve 2 lines of vertical space for the title
                    // even when it's only 1 line long. Some labels
                    // ("Pending Pod", "HyperNode 总数") wrap at typical
                    // KPI card widths; without a reserved height the
                    // value below would float up on single-line cards
                    // and the row's numbers wouldn't share a baseline.
                    minHeight: 40,
                  }}
                >
                  {intl.formatMessage({
                    id: `pages.compute.overview.kpi.${k.key}`,
                  })}
                </div>
                <div
                  style={{
                    fontSize: 24,
                    fontWeight: 500,
                    lineHeight: 1.4,
                    color: toneColor,
                  }}
                >
                  {String(k.value)}
                  {k.suffix && (
                    <span style={{ fontSize: 14, marginInlineStart: 4 }}>
                      {k.suffix}
                    </span>
                  )}
                </div>
              </Card>
            </Col>
          );
        })}
      </Row>

      {/* Scheduler config summary — actions + tier plugins as compact chips.
          Hidden when configmap fetch returned null. */}
      {data?.scheduler && <SchedulerSummaryCard summary={data.scheduler} />}

      {ready ? (
        <Suspense
          fallback={
            <div
              style={{
                height: 480,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Spin />
            </div>
          }
        >
          <Charts data={data} />
        </Suspense>
      ) : loading ? (
        <div
          style={{
            height: 480,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Spin size="large" />
        </div>
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={intl.formatMessage({
            id: 'pages.compute.overview.empty',
          })}
        >
          <Button onClick={refresh} icon={<ReloadOutlined />}>
            {intl.formatMessage({ id: 'pages.workloads.refresh' })}
          </Button>
        </Empty>
      )}

      {/* Operational lists at the bottom: failed-jobs triage on the
          left, latest-jobs feed on the right. Plain antd List rather
          than another chart — these are scan-and-act views. */}
      {ready && (
        <Row gutter={[12, 12]} style={{ marginTop: 12 }} align="stretch">
          <Col xs={24} lg={12}>
            <JobListCard
              titleId="pages.compute.overview.failed.title"
              emptyId="pages.compute.overview.failed.empty"
              jumpId="pages.compute.overview.failed.jump"
              jobs={failedJobs}
              clusterId={clusterId}
              accentTone="error"
            />
          </Col>
          <Col xs={24} lg={12}>
            <JobListCard
              titleId="pages.compute.overview.recent.title"
              emptyId="pages.compute.overview.recent.empty"
              jumpId="pages.compute.overview.recent.jump"
              jobs={recentJobs}
              clusterId={clusterId}
            />
          </Col>
        </Row>
      )}
    </div>
  );
}

interface Kpi {
  key: string;
  value: number | string;
  suffix?: string;
  tone?: 'warn' | 'error' | 'ok';
}

function buildKpis(data: BundleData | undefined): Kpi[] {
  if (!data) {
    return [
      { key: 'queues', value: 0 },
      { key: 'jobs', value: 0 },
      { key: 'pods.running', value: 0 },
      { key: 'pods.pending', value: 0 },
      { key: 'jobs.failed', value: 0 },
      { key: 'hypernodes', value: 0 },
      { key: 'wait.max', value: '-' },
      { key: 'wait.avg', value: '-' },
    ];
  }
  const runningPods = data.jobs.reduce((s, j) => s + (j.running ?? 0), 0);
  const pendingPods = data.jobs.reduce((s, j) => s + (j.pending ?? 0), 0);
  const failedJobs = data.jobs.filter((j) => isFailureState(j.state)).length;
  // Pending / Inqueue waits: how long has each PodGroup been
  // queued. Surfaces stuck workloads (capacity exhaustion, missing
  // resources, predicate failures) at a glance.
  const waitingMs: number[] = [];
  const now = Date.now();
  for (const pg of data.podGroups) {
    if (pg.phase !== 'Pending' && pg.phase !== 'Inqueue') continue;
    const t = new Date(pg.creationTimestamp).getTime();
    if (Number.isFinite(t)) waitingMs.push(now - t);
  }
  const maxWait = waitingMs.length > 0 ? Math.max(...waitingMs) : 0;
  const avgWait =
    waitingMs.length > 0
      ? waitingMs.reduce((s, n) => s + n, 0) / waitingMs.length
      : 0;
  return [
    { key: 'queues', value: data.queues.length },
    { key: 'jobs', value: data.jobs.length },
    { key: 'pods.running', value: runningPods, tone: 'ok' },
    {
      key: 'pods.pending',
      value: pendingPods,
      tone: pendingPods > 0 ? 'warn' : undefined,
    },
    {
      key: 'jobs.failed',
      value: failedJobs,
      tone: failedJobs > 0 ? 'error' : undefined,
    },
    { key: 'hypernodes', value: data.hyperNodes.length },
    {
      key: 'wait.max',
      value: waitingMs.length > 0 ? formatDuration(maxWait) : '-',
      tone:
        maxWait > 10 * 60 * 1000
          ? 'error'
          : maxWait > 60 * 1000
            ? 'warn'
            : undefined,
    },
    {
      key: 'wait.avg',
      value: waitingMs.length > 0 ? formatDuration(avgWait) : '-',
    },
  ];
}

// formatDuration is the same kubectl-style "5m / 3h / 2d" formatter
// the list pages use for Age, just specialized for ms input.
function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function isFailureState(s: string): boolean {
  return s === 'Failed' || s === 'Terminated' || s === 'Aborted';
}

function topFailedJobs(data: BundleData | undefined, n: number): JobRow[] {
  if (!data) return [];
  return data.jobs
    .filter((j) => isFailureState(j.state))
    .sort(
      (a, b) =>
        new Date(b.creationTimestamp).getTime() -
        new Date(a.creationTimestamp).getTime(),
    )
    .slice(0, n);
}

function topRecentJobs(data: BundleData | undefined, n: number): JobRow[] {
  if (!data) return [];
  return [...data.jobs]
    .sort(
      (a, b) =>
        new Date(b.creationTimestamp).getTime() -
        new Date(a.creationTimestamp).getTime(),
    )
    .slice(0, n);
}

const STATE_COLORS: Record<string, string> = {
  Running: 'green',
  Completed: 'blue',
  Pending: 'gold',
  Failed: 'red',
  Terminated: 'red',
  Aborted: 'red',
  Restarting: 'orange',
  Terminating: 'orange',
  Aborting: 'orange',
};

function JobListCard({
  titleId,
  emptyId,
  jumpId,
  jobs,
  clusterId,
  accentTone,
}: {
  titleId: string;
  emptyId: string;
  jumpId: string;
  jobs: JobRow[];
  clusterId: string;
  accentTone?: 'error' | 'warn';
}) {
  const intl = useIntl();
  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={
        <Space>
          {intl.formatMessage({ id: titleId })}
          {jobs.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              ({jobs.length})
            </Text>
          )}
        </Space>
      }
      extra={
        <Button
          type="link"
          size="small"
          onClick={() => history.push(`/compute/${clusterId}/jobs`)}
        >
          {intl.formatMessage({ id: jumpId })}
          <ArrowRightOutlined />
        </Button>
      }
      styles={{ body: { padding: '8px 12px' } }}
    >
      {jobs.length === 0 ? (
        <div
          style={{
            color:
              accentTone === 'error'
                ? 'var(--ant-color-success)'
                : 'var(--ant-color-text-tertiary)',
            fontSize: 13,
            padding: '12px 0',
            textAlign: 'center',
          }}
        >
          {intl.formatMessage({ id: emptyId })}
        </div>
      ) : (
        <List
          size="small"
          dataSource={jobs}
          rowKey="uid"
          renderItem={(job) => (
            <List.Item
              style={{ padding: '6px 0' }}
              actions={[
                <Text
                  key="age"
                  type="secondary"
                  style={{ fontSize: 12 }}
                >
                  {formatAge(job.creationTimestamp)}
                </Text>,
              ]}
            >
              <Space size={8} wrap>
                <Tag color={STATE_COLORS[job.state] ?? 'default'}>
                  {job.state || 'Unknown'}
                </Tag>
                <Text
                  strong
                  style={{ fontSize: 13 }}
                  ellipsis={{ tooltip: `${job.namespace}/${job.name}` }}
                >
                  {job.name}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {job.namespace}
                  {job.queue ? ` · ${job.queue}` : ''}
                </Text>
              </Space>
            </List.Item>
          )}
        />
      )}
    </Card>
  );
}

function SchedulerSummaryCard({
  summary,
}: {
  summary: SchedulerConfSummary;
}) {
  const intl = useIntl();
  return (
    <Card
      size="small"
      title={intl.formatMessage({
        id: 'pages.compute.overview.scheduler.title',
      })}
      style={{ marginBottom: 12 }}
      styles={{ body: { padding: '10px 14px' } }}
    >
      <Space wrap size={[8, 8]}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {intl.formatMessage({
            id: 'pages.compute.overview.scheduler.actions',
          })}
        </Text>
        {summary.actions.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            -
          </Text>
        ) : (
          summary.actions.map((a) => (
            <Tag key={a} color="blue" style={{ marginInlineEnd: 0 }}>
              {a}
            </Tag>
          ))
        )}
      </Space>
      <div style={{ height: 8 }} />
      {summary.tiers.map((tier, i) => (
        <div key={i} style={{ marginTop: 4 }}>
          <Space wrap size={[8, 6]}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {intl.formatMessage(
                { id: 'pages.compute.overview.scheduler.tier' },
                { n: i + 1 },
              )}
            </Text>
            {tier.length === 0 ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                -
              </Text>
            ) : (
              tier.map((p) => (
                <Tag key={p} color="green" style={{ marginInlineEnd: 0 }}>
                  {p}
                </Tag>
              ))
            )}
          </Space>
        </div>
      ))}
    </Card>
  );
}

// Re-exports so the lazy-loaded OverviewCharts can share types
// without import-path traversal.
export { formatAge };
