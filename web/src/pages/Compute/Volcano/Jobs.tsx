import { PlusOutlined } from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { useIntl, useModel, useParams, useRequest } from '@umijs/max';
import { App, Button, Dropdown, Space, Tag, Typography } from 'antd';
import React, { useState } from 'react';

import {
  listVolcanoJobs,
  type JobRow,
} from '@/services/kpilot/volcano-list';
import { sendCommand, type VolcanoAction } from '@/services/kpilot/volcano';
import { deleteWorkload } from '@/services/kpilot/workload';
import { JobFormDrawer } from './JobForm';
import {
  NotInstalled,
  RefreshControl,
  formatAge,
  isResourceNotAvailable,
  useAutoRefresh,
} from './shared/Layout';

// Volcano Job (`batch.volcano.sh/v1alpha1`) — gang-scheduled batch
// job. One server fetch returns spec + status (state.phase, pod
// counts, task images) per job; rendering 100 jobs is one request.
export default function VolcanoJobsPage() {
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
    () => listVolcanoJobs(clusterId!, ns),
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

  const onDelete = (record: JobRow) => {
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
              kind: 'Job',
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

  const columns: ProColumns<JobRow>[] = [
    {
      title: 'Name',
      dataIndex: 'name',
      copyable: true,
      width: 200,
      fixed: 'left',
    },
    {
      title: 'Namespace',
      dataIndex: 'namespace',
      width: 140,
    },
    {
      title: 'State',
      dataIndex: 'state',
      width: 120,
      render: (_, r) => <JobStateTag state={r.state} />,
    },
    {
      title: 'Queue',
      dataIndex: 'queue',
      width: 140,
      render: (_, r) => r.queue || 'default',
    },
    {
      title: 'minAvailable',
      dataIndex: 'minAvailable',
      width: 100,
    },
    {
      title: '任务',
      key: 'tasks',
      width: 200,
      render: (_, r) => (
        <Space direction="vertical" size={0} style={{ lineHeight: 1.4 }}>
          {(r.tasks ?? []).map((t) => (
            <Typography.Text
              key={t.name}
              style={{ fontSize: 12 }}
              ellipsis={{ tooltip: t.image }}
            >
              {t.name} × {t.replicas}
            </Typography.Text>
          ))}
        </Space>
      ),
    },
    {
      title: 'Pods',
      key: 'pods',
      width: 220,
      render: (_, r) => (
        <Space size={4} wrap>
          {r.running > 0 && <Tag color="green">Running {r.running}</Tag>}
          {r.pending > 0 && <Tag color="gold">Pending {r.pending}</Tag>}
          {r.succeeded > 0 && (
            <Tag color="blue">Succeeded {r.succeeded}</Tag>
          )}
          {r.failed > 0 && <Tag color="red">Failed {r.failed}</Tag>}
          {r.terminating > 0 && (
            <Tag color="orange">Terminating {r.terminating}</Tag>
          )}
          {r.unknown > 0 && <Tag>Unknown {r.unknown}</Tag>}
          {r.running + r.pending + r.succeeded + r.failed + r.terminating + r.unknown ===
            0 && <Typography.Text type="secondary">-</Typography.Text>}
        </Space>
      ),
    },
    {
      title: 'Plugins',
      dataIndex: 'plugins',
      width: 160,
      render: (_, r) =>
        r.plugins && r.plugins.length > 0 ? (
          <Space size={2} wrap>
            {r.plugins.map((p) => (
              <Tag key={p}>{p}</Tag>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: 'Age',
      key: 'age',
      width: 80,
      render: (_, r) => formatAge(r.creationTimestamp),
    },
    {
      title: intl.formatMessage({ id: 'pages.workloads.col.actions' }),
      key: 'action',
      fixed: 'right',
      width: 220,
      render: (_, record) => (
        <Space size={0}>
          <JobLifecycleAction record={record} refresh={refresh} />
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
      <ProTable<JobRow>
        rowKey="uid"
        columns={columns}
        dataSource={data ?? []}
        loading={loading}
        search={false}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        scroll={{ x: 'max-content' }}
        options={{ reload: false }}
        headerTitle={
          <Space>
            <Typography.Text strong>Job</Typography.Text>
            <Typography.Text type="secondary">
              ({data?.length ?? 0})
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
            {intl.formatMessage({ id: 'pages.compute.job.create' })}
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
      <JobFormDrawer
        open={createOpen}
        clusterId={clusterId}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false);
          refresh();
        }}
      />
      <JobFormDrawer
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

// JobStateTag colours the Volcano Job phase. Phases include Pending,
// Aborting, Aborted, Running, Restarting, Completing, Completed,
// Terminating, Terminated, Failed.
function JobStateTag({ state }: { state: string }) {
  if (!state) return <Tag>-</Tag>;
  const color = ((): string => {
    switch (state) {
      case 'Running':
        return 'green';
      case 'Completed':
      case 'Completing':
        return 'blue';
      case 'Pending':
        return 'gold';
      case 'Failed':
      case 'Terminated':
      case 'Aborted':
        return 'red';
      case 'Restarting':
      case 'Terminating':
      case 'Aborting':
        return 'orange';
      default:
        return 'default';
    }
  })();
  return <Tag color={color}>{state}</Tag>;
}

// JobLifecycleAction is the per-row "操作" dropdown (Resume / Abort /
// Restart / Complete / Terminate). Drops a Command CR pointed at the
// Job; the Volcano controller picks it up and applies the action.
function JobLifecycleAction({
  record,
  refresh,
}: {
  record: JobRow;
  refresh: () => void;
}) {
  const intl = useIntl();
  const { message, modal } = App.useApp();
  const { id: clusterId } = useParams<{ id: string }>();
  if (!clusterId) return null;

  const ACTION_LABEL_ID: Record<string, string> = {
    ResumeJob: 'pages.compute.job.action.resume',
    AbortJob: 'pages.compute.job.action.abort',
    RestartJob: 'pages.compute.job.action.restart',
    CompleteJob: 'pages.compute.job.action.complete',
    TerminateJob: 'pages.compute.job.action.terminate',
  };

  const fire = async (action: VolcanoAction) => {
    try {
      const res = await sendCommand(clusterId, action, {
        apiVersion: 'batch.volcano.sh/v1alpha1',
        kind: 'Job',
        name: record.name,
        namespace: record.namespace,
      });
      const fail = res?.results?.find((r) => !r.success);
      if (fail) {
        message.error(fail.error ?? 'command failed');
        return;
      }
      message.success(
        intl.formatMessage({ id: 'pages.compute.job.commandSent' }),
      );
      [600, 2500].forEach((d) => setTimeout(refresh, d));
    } catch (e: any) {
      const m = e?.response?.data?.message ?? e?.message;
      if (m) message.error(String(m));
    }
  };

  const items = (Object.keys(ACTION_LABEL_ID) as VolcanoAction[]).map((a) => ({
    key: a,
    label: intl.formatMessage({ id: ACTION_LABEL_ID[a] }),
    danger: a === 'TerminateJob',
  }));

  return (
    <Dropdown
      menu={{
        items,
        onClick: ({ key }) => {
          const action = key as VolcanoAction;
          modal.confirm({
            title: intl.formatMessage(
              { id: 'pages.compute.job.action.confirm' },
              {
                name: record.name,
                action: intl.formatMessage({ id: ACTION_LABEL_ID[action] }),
              },
            ),
            okType: action === 'TerminateJob' ? 'danger' : 'primary',
            onOk: () => fire(action),
          });
        },
      }}
    >
      <Button type="link" size="small">
        {intl.formatMessage({ id: 'pages.compute.job.action.menu' })}
      </Button>
    </Dropdown>
  );
}
