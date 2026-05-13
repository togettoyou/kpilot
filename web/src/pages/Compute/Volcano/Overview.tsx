import { ReloadOutlined } from '@ant-design/icons';
import { useIntl, useModel, useParams, useRequest } from '@umijs/max';
import { Button, Card, Col, Empty, Row, Space, Spin, Statistic, Tag } from 'antd';
import React, { lazy, Suspense, useMemo } from 'react';

import {
  listVolcanoCronJobs,
  listVolcanoHyperNodes,
  listVolcanoJobs,
  listVolcanoPodGroups,
  listVolcanoQueues,
  type CronJobRow,
  type HyperNodeRow,
  type JobRow,
  type PodGroupRow,
  type QueueRow,
} from '@/services/kpilot/volcano-list';
import {
  NotInstalled,
  RefreshControl,
  formatAge,
  isResourceNotAvailable,
  useAutoRefresh,
} from './shared/Layout';

// Overview is the Volcano dashboard: aggregates the five core list
// endpoints into a single fetch, projects them onto a handful of
// glance-able charts (per-queue resources, Job phase pie, PodGroup
// phase pie, CronJob suspend split, HyperNode tier histogram) plus
// KPI cards on top. Charts come from @ant-design/plots — bundled
// with G2 v5 — so we route them through React.lazy + Suspense to
// keep the page light until the user actually opens it.

const Charts = lazy(() => import('./OverviewCharts'));

interface BundleData {
  queues: QueueRow[];
  jobs: JobRow[];
  cronJobs: CronJobRow[];
  podGroups: PodGroupRow[];
  hyperNodes: HyperNodeRow[];
  truncated: boolean;
}

export default function VolcanoOverviewPage() {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  // Namespaced lists honor the global picker so per-namespace views
  // stay consistent across pages. Cluster-scoped resources (Queue,
  // HyperNode) ignore it.
  const namespaceModel = useModel('namespace');
  const ns = clusterId ? namespaceModel.get(clusterId).selected : '';

  const { data, loading, error, refresh } = useRequest(
    async (): Promise<BundleData> => {
      const [queues, jobs, cronJobs, podGroups, hyperNodes] =
        await Promise.all([
          listVolcanoQueues(clusterId!),
          listVolcanoJobs(clusterId!, ns),
          listVolcanoCronJobs(clusterId!, ns),
          listVolcanoPodGroups(clusterId!, ns),
          listVolcanoHyperNodes(clusterId!),
        ]);
      return {
        queues: queues.items ?? [],
        jobs: jobs.items ?? [],
        cronJobs: cronJobs.items ?? [],
        podGroups: podGroups.items ?? [],
        hyperNodes: hyperNodes.items ?? [],
        truncated: !!(
          queues.continue ||
          jobs.continue ||
          cronJobs.continue ||
          podGroups.continue ||
          hyperNodes.continue
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

  if (!clusterId) return null;
  if (error && isResourceNotAvailable(error)) {
    return <NotInstalled clusterId={clusterId} />;
  }

  const kpis = useMemo(() => buildKpis(data), [data]);
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

      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        {kpis.map((k) => (
          <Col key={k.key} xs={12} sm={8} md={6} lg={4} xl={4}>
            <Card size="small" loading={loading && !ready}>
              <Statistic
                title={intl.formatMessage({
                  id: `pages.compute.overview.kpi.${k.key}`,
                })}
                value={k.value}
                valueStyle={
                  k.tone === 'warn'
                    ? { color: 'var(--ant-color-warning)' }
                    : k.tone === 'error'
                      ? { color: 'var(--ant-color-error)' }
                      : k.tone === 'ok'
                        ? { color: 'var(--ant-color-success)' }
                        : undefined
                }
              />
            </Card>
          </Col>
        ))}
      </Row>

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
    </div>
  );
}

interface Kpi {
  key: string;
  value: number;
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
    ];
  }
  const runningPods = data.jobs.reduce((s, j) => s + (j.running ?? 0), 0);
  const pendingPods = data.jobs.reduce((s, j) => s + (j.pending ?? 0), 0);
  const failedJobs = data.jobs.filter(
    (j) => j.state === 'Failed' || j.state === 'Terminated' || j.state === 'Aborted',
  ).length;
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
  ];
}

// Allow OverviewCharts to read the same row types we expose here so
// the chart file is self-contained.
export type { BundleData };
// Re-export formatAge so the chart file can render an axis label
// without a separate import path traversal.
export { formatAge };
