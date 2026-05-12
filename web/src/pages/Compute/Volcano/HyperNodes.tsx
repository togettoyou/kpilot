import { PlusOutlined } from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { useIntl, useParams, useRequest } from '@umijs/max';
import { App, Button, Popconfirm, Space, Tag, Typography } from 'antd';
import React, { useState } from 'react';

import {
  listVolcanoHyperNodes,
  type HyperNodeRow,
} from '@/services/kpilot/volcano-list';
import { deleteWorkload } from '@/services/kpilot/workload';
import { DescribeDrawer } from '@/pages/ClusterDetail/Workloads/DescribeDrawer';
import { HyperNodeFormDrawer } from './HyperNodeForm';
import {
  NotInstalled,
  RefreshControl,
  TruncatedBanner,
  formatAge,
  isResourceNotAvailable,
  useAutoRefresh,
} from './shared/Layout';

// Volcano HyperNode (`topology.volcano.sh/v1alpha1`) — declares
// network topology for topology-aware scheduling. Cluster-scoped.
// 新建 / 编辑 covers tier number, optional tierName, and the members
// list (each with type=Node|HyperNode + exactly one selector branch).
export default function VolcanoHyperNodesPage() {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const { message } = App.useApp();

  const { data, loading, error, refresh } = useRequest(
    () => listVolcanoHyperNodes(clusterId!),
    {
      formatResult: (res) => res,
      ready: !!clusterId,
      refreshDeps: [clusterId],
    },
  );

  const [interval, setInterval] = useAutoRefresh(refresh, !!clusterId);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [describingName, setDescribingName] = useState<string | null>(null);

  if (!clusterId) return null;
  if (error && isResourceNotAvailable(error)) {
    return <NotInstalled clusterId={clusterId} />;
  }

  const items = data?.items ?? [];
  const truncated = !!data?.continue;

  const doDelete = async (name: string) => {
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
  };

  const columns: ProColumns<HyperNodeRow>[] = [
    {
      title: intl.formatMessage({ id: 'pages.compute.hyperNode.col.name' }),
      dataIndex: 'name',
      width: 220,
      fixed: 'left',
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.hyperNode.col.tier' }),
      dataIndex: 'tier',
      width: 80,
      render: (_, r) => <Tag color="blue">tier {r.tier}</Tag>,
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.hyperNode.col.members' }),
      key: 'members',
      width: 360,
      render: (_, r) => (
        <Space direction="vertical" size={2} style={{ lineHeight: 1.4 }}>
          {(r.members ?? []).map((m, i) => (
            <div
              key={i}
              style={{
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Tag
                color={m.type === 'Node' ? 'cyan' : 'geekblue'}
                style={{ marginInlineEnd: 0 }}
              >
                {m.type}
              </Tag>
              <span style={{ color: 'var(--ant-color-text-secondary)' }}>
                {m.selector}
              </span>
            </div>
          ))}
          {(!r.members || r.members.length === 0) && (
            <Typography.Text type="secondary">-</Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.hyperNode.col.age' }),
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
      <ProTable<HyperNodeRow>
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
            <Typography.Text strong>HyperNode</Typography.Text>
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
            {intl.formatMessage({ id: 'pages.compute.hyperNode.create' })}
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
      <HyperNodeFormDrawer
        open={createOpen}
        clusterId={clusterId}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false);
          refresh();
        }}
      />
      <HyperNodeFormDrawer
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
        cr={{
          group: 'topology.volcano.sh',
          version: 'v1alpha1',
          kind: 'HyperNode',
          scope: 'Cluster',
        }}
      />
    </div>
  );
}
