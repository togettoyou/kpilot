import { PlusOutlined } from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { useIntl, useModel, useParams } from '@umijs/max';

import { useVolcanoList } from '@/hooks/useVolcanoList';
import { useBurstRefresh } from '@/hooks/useBurstRefresh';
import { App, Button, Popconfirm, Space, Tag, Typography } from 'antd';
import React, { useState } from 'react';

import { DescribeDrawer } from '@/pages/ClusterDetail/Workloads/DescribeDrawer';
import {
  listVolcanoColocationConfigurations,
  type ColocationConfigurationRow,
} from '@/services/kpilot/volcano-list';
import { deleteWorkload } from '@/services/kpilot/workload';
import { ColocationConfigurationFormDrawer } from './ColocationConfigurationForm';
import {
  NotInstalled,
  RefreshControl,
  ResourceIntro,
  TruncatedBanner,
  formatAge,
  isResourceNotAvailable,
  useAutoRefresh,
} from './shared/Layout';

// ColocationConfiguration (`config.volcano.sh/v1alpha1`) — namespaced.
// Memory QoS cgroup ratios for the matchLabels-selected pods.
// Requires the volcano-agent DaemonSet + kernel cgroup memory.{high,
// low,min} support to actually take effect at the kernel level.

const CR = {
  group: 'config.volcano.sh',
  version: 'v1alpha1',
  kind: 'ColocationConfiguration',
  scope: 'Namespaced' as const,
};

export default function VolcanoColocationConfigurationsPage() {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const { message } = App.useApp();
  const namespaceModel = useModel('namespace');
  const ns = clusterId ? namespaceModel.get(clusterId).selected : '';

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<{
    name: string;
    namespace: string;
  } | null>(null);
  const [describing, setDescribing] = useState<{
    name: string;
    namespace: string;
  } | null>(null);

  const { items, loading, error, refresh, loadMore, hasMore, total } =
    useVolcanoList(
      (cont) =>
        listVolcanoColocationConfigurations(clusterId!, ns, {
          continueToken: cont,
        }),
      [clusterId, ns],
      { ready: !!clusterId },
    );

  const [interval, setInterval] = useAutoRefresh(refresh, !!clusterId);
  const { burst } = useBurstRefresh(refresh);

  if (!clusterId) return null;
  if (error && isResourceNotAvailable(error)) {
    return <NotInstalled clusterId={clusterId} />;
  }

  const doDelete = async (record: ColocationConfigurationRow) => {
    try {
      await deleteWorkload(clusterId, '_cr', record.name, record.namespace, CR);
      message.success(
        intl.formatMessage({ id: 'pages.workloads.delete.success' }),
      );
      burst();
    } catch (e: any) {
      const m = e?.response?.data?.message ?? e?.message;
      if (m) message.error(String(m));
    }
  };

  const columns: ProColumns<ColocationConfigurationRow>[] = [
    {
      title: intl.formatMessage({ id: 'pages.compute.colocation.col.name' }),
      dataIndex: 'name',
      width: 200,
      fixed: 'left',
    },
    {
      title: intl.formatMessage({
        id: 'pages.compute.colocation.col.namespace',
      }),
      dataIndex: 'namespace',
      width: 140,
    },
    {
      title: intl.formatMessage({
        id: 'pages.compute.colocation.col.selector',
      }),
      dataIndex: 'selectorSummary',
      width: 240,
      render: (_, r) =>
        r.selectorSummary ? (
          <Typography.Text style={{ fontSize: 12 }} code>
            {r.selectorSummary}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: 'MemoryQoS',
      key: 'memoryQos',
      width: 280,
      render: (_, r) => (
        <Space size={4}>
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
            high {r.highRatio}
          </Tag>
          <Tag color="cyan" style={{ marginInlineEnd: 0 }}>
            low {r.lowRatio}
          </Tag>
          <Tag color="purple" style={{ marginInlineEnd: 0 }}>
            min {r.minRatio}
          </Tag>
        </Space>
      ),
    },
    {
      title: intl.formatMessage({
        id: 'pages.compute.colocation.col.available',
      }),
      dataIndex: 'available',
      width: 110,
      render: (_, r) => {
        if (!r.available) return <Tag>-</Tag>;
        const color =
          r.available === 'True'
            ? 'green'
            : r.available === 'False'
              ? 'red'
              : 'default';
        return <Tag color={color}>{r.available}</Tag>;
      },
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.colocation.col.age' }),
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
            onClick={() =>
              setDescribing({ name: record.name, namespace: record.namespace })
            }
          >
            {intl.formatMessage({ id: 'pages.workloads.describe' })}
          </Button>
          <Button
            type="link"
            size="small"
            onClick={() =>
              setEditing({ name: record.name, namespace: record.namespace })
            }
          >
            {intl.formatMessage({ id: 'pages.workloads.edit' })}
          </Button>
          <Popconfirm
            title={intl.formatMessage(
              { id: 'pages.workloads.delete.confirm' },
              { name: record.name },
            )}
            onConfirm={() => doDelete(record)}
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
      <ResourceIntro id="pages.compute.intro.colocationconfiguration" />
      {hasMore && (
        <TruncatedBanner
          shown={items.length}
          total={total}
          onLoadMore={loadMore}
          loading={loading}
        />
      )}
      <ProTable<ColocationConfigurationRow>
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
            <Typography.Text strong>ColocationConfiguration</Typography.Text>
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
            {intl.formatMessage({ id: 'pages.compute.colocation.create' })}
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
      <ColocationConfigurationFormDrawer
        open={createOpen}
        clusterId={clusterId}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false);
          burst();
        }}
      />
      <ColocationConfigurationFormDrawer
        open={!!editing}
        clusterId={clusterId}
        editing={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          burst();
        }}
      />
      <DescribeDrawer
        open={!!describing}
        onClose={() => setDescribing(null)}
        clusterId={clusterId}
        resourceType="_cr"
        name={describing?.name ?? ''}
        namespace={describing?.namespace ?? ''}
        cr={CR}
      />
    </div>
  );
}
