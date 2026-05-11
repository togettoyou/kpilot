import { PlusOutlined } from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { useIntl, useModel, useParams, useRequest } from '@umijs/max';
import { App, Button, Popconfirm, Space, Tag, Typography } from 'antd';
import React, { useState } from 'react';

import {
  listVolcanoCronJobs,
  type CronJobRow,
} from '@/services/kpilot/volcano-list';
import { applyManifest } from '@/services/kpilot/volcano';
import { deleteWorkload } from '@/services/kpilot/workload';
import { CronJobFormDrawer } from './CronJobForm';
import {
  NotInstalled,
  RefreshControl,
  TruncatedBanner,
  formatAge,
  isResourceNotAvailable,
  useAutoRefresh,
  useStaggeredRefresh,
} from './shared/Layout';

// Volcano CronJob (`batch.volcano.sh/v1alpha1`) — schedules a Volcano
// Job on a cron expression. One server fetch returns spec.suspend +
// status.lastScheduleTime + active count for every CronJob.
export default function VolcanoCronJobsPage() {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const { message, modal } = App.useApp();
  const namespaceModel = useModel('namespace');
  const ns = clusterId ? namespaceModel.get(clusterId).selected : '';

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<{
    name: string;
    namespace: string;
  } | null>(null);

  const { data, loading, error, refresh } = useRequest(
    () => listVolcanoCronJobs(clusterId!, ns),
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

  const items = data?.items ?? [];
  const truncated = !!data?.continue;

  const onDelete = (record: CronJobRow) => {
    modal.confirm({
      title: intl.formatMessage(
        { id: 'pages.workloads.delete.confirm' },
        { name: record.name },
      ),
      okType: 'danger',
      onOk: async () => {
        try {
          await deleteWorkload(
            clusterId,
            '_cr',
            record.name,
            record.namespace,
            {
              group: 'batch.volcano.sh',
              version: 'v1alpha1',
              kind: 'CronJob',
              scope: 'Namespaced',
            },
          );
          message.success(
            intl.formatMessage({ id: 'pages.workloads.delete.success' }),
          );
          refresh();
        } catch (e: any) {
          const m = e?.response?.data?.message ?? e?.message;
          if (m) message.error(String(m));
        }
      },
    });
  };

  const columns: ProColumns<CronJobRow>[] = [
    {
      title: intl.formatMessage({ id: 'pages.compute.cronJob.col.name' }),
      dataIndex: 'name',
      width: 200,
      fixed: 'left',
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.cronJob.col.namespace' }),
      dataIndex: 'namespace',
      width: 140,
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.cronJob.col.schedule' }),
      dataIndex: 'schedule',
      width: 160,
      render: (_, r) => (
        <Typography.Text code style={{ fontSize: 12 }}>
          {r.schedule}
        </Typography.Text>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.cronJob.col.state' }),
      dataIndex: 'suspend',
      width: 110,
      render: (_, r) => (
        <Tag color={r.suspend ? 'orange' : 'green'}>
          {intl.formatMessage({
            id: r.suspend
              ? 'pages.compute.cronJob.state.suspended'
              : 'pages.compute.cronJob.state.running',
          })}
        </Tag>
      ),
    },
    {
      title: intl.formatMessage({
        id: 'pages.compute.cronJob.col.concurrency',
      }),
      dataIndex: 'concurrencyPolicy',
      width: 120,
      render: (_, r) => r.concurrencyPolicy || 'Allow',
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.cronJob.col.active' }),
      dataIndex: 'activeCount',
      width: 80,
    },
    {
      title: intl.formatMessage({
        id: 'pages.compute.cronJob.col.lastSchedule',
      }),
      key: 'lastScheduleTime',
      width: 100,
      render: (_, r) =>
        r.lastScheduleTime
          ? intl.formatMessage(
              { id: 'pages.compute.cronJob.lastScheduleAgo' },
              { age: formatAge(r.lastScheduleTime) },
            )
          : '-',
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.cronJob.col.age' }),
      key: 'age',
      width: 80,
      render: (_, r) => formatAge(r.creationTimestamp),
    },
    {
      title: intl.formatMessage({ id: 'pages.workloads.col.actions' }),
      key: 'action',
      fixed: 'right',
      width: 240,
      render: (_, record) => (
        <Space size={0}>
          <SuspendAction record={record} refresh={refresh} />
          <Button
            type="link"
            size="small"
            onClick={() =>
              setEditing({ name: record.name, namespace: record.namespace })
            }
          >
            {intl.formatMessage({ id: 'pages.workloads.edit' })}
          </Button>
          <Button
            type="link"
            size="small"
            danger
            onClick={() => onDelete(record)}
          >
            {intl.formatMessage({ id: 'pages.workloads.delete' })}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="p-6">
      {truncated && (
        <TruncatedBanner shown={items.length} count={items.length} />
      )}
      <ProTable<CronJobRow>
        rowKey="uid"
        columns={columns}
        dataSource={items}
        loading={loading}
        search={false}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        scroll={{ x: 'max-content' }}
        options={{ reload: false }}
        headerTitle={
          <Space>
            <Typography.Text strong>CronJob</Typography.Text>
            <Typography.Text type="secondary">
              ({items.length})
            </Typography.Text>
          </Space>
        }
        toolBarRender={() => [
          <Button
            key="new"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCreateOpen(true)}
          >
            {intl.formatMessage({ id: 'pages.compute.cronJob.create' })}
          </Button>,
          <RefreshControl
            key="refresh"
            interval={interval}
            setInterval={setInterval}
            refresh={refresh}
            loading={loading}
          />,
        ]}
      />
      <CronJobFormDrawer
        open={createOpen}
        clusterId={clusterId}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false);
          refresh();
        }}
      />
      <CronJobFormDrawer
        open={!!editing}
        clusterId={clusterId}
        editing={editing ?? undefined}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />
    </div>
  );
}

// SuspendAction patches spec.suspend via SSA. The bool comes from the
// row prop — no per-row fetch.
function SuspendAction({
  record,
  refresh,
}: {
  record: CronJobRow;
  refresh: () => void;
}) {
  const intl = useIntl();
  const { message } = App.useApp();
  const { id: clusterId } = useParams<{ id: string }>();
  const fireRefresh = useStaggeredRefresh(refresh);
  if (!clusterId) return null;

  const next = !record.suspend;
  const labelId = record.suspend
    ? 'pages.compute.cronJob.action.resume'
    : 'pages.compute.cronJob.action.suspend';
  const confirmId = record.suspend
    ? 'pages.compute.cronJob.confirm.resume'
    : 'pages.compute.cronJob.confirm.suspend';

  const onConfirm = async () => {
    try {
      const res = await applyManifest(clusterId, {
        apiVersion: 'batch.volcano.sh/v1alpha1',
        kind: 'CronJob',
        metadata: { name: record.name, namespace: record.namespace },
        spec: { suspend: next },
      });
      const fail = res?.results?.find((r) => !r.success);
      if (fail) {
        message.error(fail.error ?? 'patch failed');
        return;
      }
      message.success(
        intl.formatMessage({
          id: next
            ? 'pages.compute.cronJob.suspended'
            : 'pages.compute.cronJob.resumed',
        }),
      );
      fireRefresh([400, 1500]);
    } catch (e: any) {
      const m = e?.response?.data?.message ?? e?.message;
      if (m) message.error(String(m));
    }
  };

  // Suspend is the destructive flip — paint danger.
  const isSuspending = next;
  return (
    <Popconfirm
      title={intl.formatMessage({ id: confirmId }, { name: record.name })}
      onConfirm={onConfirm}
      okType={isSuspending ? 'danger' : 'primary'}
    >
      <Button type="link" size="small" danger={isSuspending}>
        {intl.formatMessage({ id: labelId })}
      </Button>
    </Popconfirm>
  );
}
