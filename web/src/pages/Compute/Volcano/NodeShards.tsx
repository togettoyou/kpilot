import { PlusOutlined } from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { useIntl, useParams, useRequest } from '@umijs/max';
import { App, Button, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd';
import React, { useState } from 'react';

import { DescribeDrawer } from '@/pages/ClusterDetail/Workloads/DescribeDrawer';
import {
  listVolcanoNodeShards,
  type NodeShardRow,
} from '@/services/kpilot/volcano-list';
import { deleteWorkload } from '@/services/kpilot/workload';
import { NodeShardFormDrawer } from './NodeShardForm';
import {
  NotInstalled,
  RefreshControl,
  TruncatedBanner,
  formatAge,
  isResourceNotAvailable,
  useAutoRefresh,
} from './shared/Layout';

// NodeShard (`shard.volcano.sh/v1alpha1`) — cluster-scoped grouping
// of nodes dedicated to a specific scheduler (multi-scheduler setups).
// status carries reconciliation deltas (nodesInUse / nodesToAdd /
// nodesToRemove); the table surfaces counts + tooltip with the names.

const NODE_SHARD_CR = {
  group: 'shard.volcano.sh',
  version: 'v1alpha1',
  kind: 'NodeShard',
  scope: 'Cluster' as const,
};

export default function VolcanoNodeShardsPage() {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const { message } = App.useApp();

  const [createOpen, setCreateOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [describingName, setDescribingName] = useState<string | null>(null);

  const { data, loading, error, refresh } = useRequest(
    () => listVolcanoNodeShards(clusterId!),
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

  const items = data?.items ?? [];
  const truncated = !!data?.continue;

  const doDelete = async (name: string) => {
    try {
      await deleteWorkload(clusterId, '_cr', name, '', NODE_SHARD_CR);
      message.success(
        intl.formatMessage({ id: 'pages.workloads.delete.success' }),
      );
      refresh();
    } catch (e: any) {
      const m = e?.response?.data?.message ?? e?.message;
      if (m) message.error(String(m));
    }
  };

  const nodeList = (label: string, list?: string[], color = 'default') => {
    if (!list || list.length === 0) return null;
    return (
      <Tooltip title={list.join(', ')}>
        <Tag color={color} style={{ marginInlineEnd: 0 }}>
          {label} {list.length}
        </Tag>
      </Tooltip>
    );
  };

  const columns: ProColumns<NodeShardRow>[] = [
    {
      title: intl.formatMessage({ id: 'pages.compute.nodeShard.col.name' }),
      dataIndex: 'name',
      width: 220,
      fixed: 'left',
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.nodeShard.col.desired' }),
      key: 'desired',
      width: 110,
      render: (_, r) => {
        const n = r.nodesDesired?.length ?? 0;
        if (n === 0) return <Typography.Text type="secondary">0</Typography.Text>;
        return (
          <Tooltip title={(r.nodesDesired ?? []).join(', ')}>
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              {n}
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.nodeShard.col.status' }),
      key: 'status',
      width: 320,
      render: (_, r) => {
        const parts = [
          nodeList('inUse', r.nodesInUse, 'green'),
          nodeList('toAdd', r.nodesToAdd, 'gold'),
          nodeList('toRemove', r.nodesToRemove, 'red'),
        ].filter(Boolean);
        if (parts.length === 0)
          return <Typography.Text type="secondary">-</Typography.Text>;
        return (
          <Space size={4} wrap>
            {parts}
          </Space>
        );
      },
    },
    {
      title: intl.formatMessage({
        id: 'pages.compute.nodeShard.col.lastUpdate',
      }),
      dataIndex: 'lastUpdateTime',
      width: 200,
      render: (_, r) => r.lastUpdateTime || '-',
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.nodeShard.col.age' }),
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
          <Button
            type="link"
            size="small"
            onClick={() => setDescribingName(record.name)}
          >
            {intl.formatMessage({ id: 'pages.workloads.describe' })}
          </Button>
          <Button
            type="link"
            size="small"
            onClick={() => setEditingName(record.name)}
          >
            {intl.formatMessage({ id: 'pages.workloads.edit' })}
          </Button>
          <Popconfirm
            title={intl.formatMessage(
              { id: 'pages.workloads.delete.confirm' },
              { name: record.name },
            )}
            onConfirm={() => doDelete(record.name)}
            okType="danger"
          >
            <Button type="link" size="small" danger>
              {intl.formatMessage({ id: 'pages.workloads.delete' })}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="p-6">
      {truncated && (
        <TruncatedBanner shown={items.length} count={items.length} />
      )}
      <ProTable<NodeShardRow>
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
            <Typography.Text strong>NodeShard</Typography.Text>
            <Typography.Text type="secondary">({items.length})</Typography.Text>
          </Space>
        }
        toolBarRender={() => [
          <Button
            key="new"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCreateOpen(true)}
          >
            {intl.formatMessage({ id: 'pages.compute.nodeShard.create' })}
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
      <NodeShardFormDrawer
        open={createOpen}
        clusterId={clusterId}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false);
          refresh();
        }}
      />
      <NodeShardFormDrawer
        open={!!editingName}
        clusterId={clusterId}
        editing={editingName ? { name: editingName } : undefined}
        onClose={() => setEditingName(null)}
        onSaved={() => {
          setEditingName(null);
          refresh();
        }}
      />
      <DescribeDrawer
        open={!!describingName}
        onClose={() => setDescribingName(null)}
        clusterId={clusterId}
        resourceType="_cr"
        name={describingName ?? ''}
        namespace=""
        cr={NODE_SHARD_CR}
      />
    </div>
  );
}
