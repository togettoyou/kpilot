import { ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import { useIntl, useRequest } from '@umijs/max';
import { App, Button, Drawer, Popconfirm, Space, Tag } from 'antd';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import React from 'react';

import { useBurstRefresh } from '@/hooks/useBurstRefresh';
import {
  getRolloutHistory,
  rolloutUndo,
  type RolloutHistoryEntry,
  type WorkloadResourceType,
} from '@/services/kpilot/workload';

dayjs.extend(relativeTime);

interface Props {
  open: boolean;
  onClose: () => void;
  clusterId: string;
  resourceType: WorkloadResourceType;
  name: string;
  namespace: string;
  onRolledBack?: () => void;
}

// RolloutHistoryDrawer renders the per-revision ReplicaSet list for
// a Deployment (kubectl rollout history equivalent) and lets the
// operator roll back to any non-current revision (kubectl rollout
// undo --to-revision=N). The "current" row is highlighted and its
// undo button disabled — rolling back to your current revision is
// a no-op the server catches anyway, but blocking it client-side
// saves a confusing toast.
export function RolloutHistoryDrawer({
  open,
  onClose,
  clusterId,
  resourceType,
  name,
  namespace,
  onRolledBack,
}: Props) {
  const intl = useIntl();
  const { message, modal } = App.useApp();

  const { data, loading, refresh } = useRequest(
    () => getRolloutHistory(clusterId, resourceType, name, namespace),
    {
      ready: open,
      refreshDeps: [open, clusterId, resourceType, name, namespace],
      formatResult: (res) => res,
    },
  );
  // Undo triggers a Deployment template patch — the controller
  // creates a new ReplicaSet and the history list shifts. Burst
  // catches the new revision row + the previously-current row's
  // status going to 0 replicas.
  const { burst } = useBurstRefresh(refresh);

  const handleUndo = (entry: RolloutHistoryEntry) => {
    modal.confirm({
      title: intl.formatMessage(
        { id: 'pages.rollout.undo.confirm' },
        { revision: entry.revision },
      ),
      okType: 'danger',
      onOk: async () => {
        try {
          const res = await rolloutUndo(
            clusterId,
            resourceType,
            name,
            namespace,
            entry.revision,
          );
          if (res.noop) {
            message.info(intl.formatMessage({ id: 'pages.rollout.undo.noop' }));
          } else {
            message.success(
              intl.formatMessage(
                { id: 'pages.rollout.undo.success' },
                { revision: res.rolledBackTo },
              ),
            );
          }
          burst();
          onRolledBack?.();
        } catch {
          // global error handler shows the toast
        }
      },
    });
  };

  const columns: ProColumns<RolloutHistoryEntry>[] = [
    {
      title: intl.formatMessage({ id: 'pages.rollout.col.revision' }),
      dataIndex: 'revision',
      width: 80,
      render: (_, r) => (
        <Space>
          <span>#{r.revision}</span>
          {r.current && (
            <Tag color="green">
              {intl.formatMessage({ id: 'pages.rollout.current' })}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.rollout.col.image' }),
      dataIndex: 'image',
      ellipsis: true,
      render: (v) => (v ? <code>{v}</code> : '—'),
    },
    {
      title: intl.formatMessage({ id: 'pages.rollout.col.replicas' }),
      dataIndex: 'replicas',
      width: 100,
      render: (_, r) => `${r.readyReplicas}/${r.replicas}`,
    },
    {
      title: intl.formatMessage({ id: 'pages.rollout.col.age' }),
      dataIndex: 'createdAt',
      width: 120,
      render: (v) => (v ? dayjs(v as string).fromNow() : '—'),
    },
    {
      title: intl.formatMessage({ id: 'pages.rollout.col.changeCause' }),
      dataIndex: 'changeCause',
      ellipsis: true,
      render: (v) => v || '—',
    },
    {
      title: intl.formatMessage({ id: 'pages.workloads.col.actions' }),
      valueType: 'option',
      width: 110,
      fixed: 'right',
      render: (_, r) => (
        <Button
          type="link"
          size="small"
          disabled={r.current}
          onClick={() => handleUndo(r)}
        >
          {intl.formatMessage({ id: 'pages.rollout.rollback' })}
        </Button>
      ),
    },
  ];

  return (
    <Drawer
      title={
        <Space>
          <span>{intl.formatMessage({ id: 'pages.rollout.title' })}</span>
          <Tag>{namespace}</Tag>
          <Tag color="blue">{name}</Tag>
        </Space>
      }
      open={open}
      onClose={onClose}
      size="large"
      maskClosable={false}
      destroyOnHidden
    >
      <ProTable<RolloutHistoryEntry>
        columns={columns}
        dataSource={data?.revisions ?? []}
        loading={loading}
        rowKey="revision"
        search={false}
        pagination={false}
        options={{ reload: refresh, density: false, setting: false }}
        scroll={{ x: 'max-content' }}
      />
    </Drawer>
  );
}

export default RolloutHistoryDrawer;
