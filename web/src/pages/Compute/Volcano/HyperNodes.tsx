import type { ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { useIntl, useParams, useRequest } from '@umijs/max';
import { App, Button, Space, Tag, Typography } from 'antd';
import React from 'react';

import {
  listVolcanoHyperNodes,
  type HyperNodeRow,
} from '@/services/kpilot/volcano-list';
import { deleteWorkload } from '@/services/kpilot/workload';
import {
  NotInstalled,
  RefreshControl,
  formatAge,
  isResourceNotAvailable,
  useAutoRefresh,
} from './shared/Layout';

// Volcano HyperNode (`topology.volcano.sh/v1alpha1`) — declares
// network topology for topology-aware scheduling. Cluster-scoped.
// Read-only-ish: HyperNodes describe physical-ish topology, so most
// users only need to view them; we expose Delete for cleanup.
export default function VolcanoHyperNodesPage() {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const { message, modal } = App.useApp();

  const { data, loading, error, refresh } = useRequest(
    () => listVolcanoHyperNodes(clusterId!),
    {
      formatResult: (res) => res,
      ready: !!clusterId,
      refreshDeps: [clusterId],
    },
  );

  const [interval, setInterval] = useAutoRefresh(refresh, !!clusterId);

  if (!clusterId) return null;
  if (error && isResourceNotAvailable(error)) {
    return <NotInstalled clusterId={clusterId} />;
  }

  const onDelete = (name: string) => {
    modal.confirm({
      title: intl.formatMessage(
        { id: 'pages.workloads.delete.confirm' },
        { name },
      ),
      okType: 'danger',
      onOk: async () => {
        try {
          await deleteWorkload(clusterId, '_cr', name, '', {
            group: 'topology.volcano.sh',
            version: 'v1alpha1',
            kind: 'HyperNode',
            scope: 'Cluster',
          });
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

  const columns: ProColumns<HyperNodeRow>[] = [
    {
      title: 'Name',
      dataIndex: 'name',
      copyable: true,
      width: 220,
      fixed: 'left',
    },
    {
      title: 'Tier',
      dataIndex: 'tier',
      width: 80,
      render: (_, r) => <Tag color="blue">tier {r.tier}</Tag>,
    },
    {
      title: '成员',
      key: 'members',
      width: 360,
      render: (_, r) => (
        <Space direction="vertical" size={2} style={{ lineHeight: 1.4 }}>
          {(r.members ?? []).map((m, i) => (
            <Typography.Text key={i} style={{ fontSize: 12 }}>
              <Tag color={m.type === 'Node' ? 'cyan' : 'geekblue'}>
                {m.type}
              </Tag>
              <span style={{ color: 'var(--ant-color-text-secondary)' }}>
                {m.selector}
              </span>
            </Typography.Text>
          ))}
          {(!r.members || r.members.length === 0) && (
            <Typography.Text type="secondary">-</Typography.Text>
          )}
        </Space>
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
      width: 100,
      render: (_, record) => (
        <Button
          type="link"
          size="small"
          danger
          onClick={() => onDelete(record.name)}
        >
          {intl.formatMessage({ id: 'pages.workloads.delete' })}
        </Button>
      ),
    },
  ];

  return (
    <div className="p-6">
      <ProTable<HyperNodeRow>
        rowKey="uid"
        columns={columns}
        dataSource={data ?? []}
        loading={loading}
        search={false}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        scroll={{ x: 'max-content' }}
        headerTitle={
          <Space>
            <Typography.Text strong>HyperNode</Typography.Text>
            <Typography.Text type="secondary">
              ({data?.length ?? 0})
            </Typography.Text>
          </Space>
        }
        toolBarRender={() => [
          <RefreshControl
            key="refresh"
            interval={interval}
            setInterval={setInterval}
            refresh={refresh}
            loading={loading}
          />,
        ]}
      />
    </div>
  );
}
