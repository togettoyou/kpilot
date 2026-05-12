import type { ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { useIntl, useParams, useRequest } from '@umijs/max';
import { Button, Space, Tag, Tooltip, Typography } from 'antd';
import React, { useState } from 'react';

import { DescribeDrawer } from '@/pages/ClusterDetail/Workloads/DescribeDrawer';
import {
  listVolcanoNumatopologies,
  type NumatopologyRow,
} from '@/services/kpilot/volcano-list';
import {
  NotInstalled,
  RefreshControl,
  ResourceIntro,
  TruncatedBanner,
  formatAge,
  isResourceNotAvailable,
  useAutoRefresh,
} from './shared/Layout';

// Numatopology (`nodeinfo.volcano.sh/v1alpha1`) — one CR per node,
// auto-populated by Volcano's resource-exporter DaemonSet. Read-only:
// no Create / Edit / Delete actions because the controller owns these
// objects and any edit you make would be reconciled away.

const NUMA_CR = {
  group: 'nodeinfo.volcano.sh',
  version: 'v1alpha1',
  kind: 'Numatopology',
  scope: 'Cluster' as const,
};

export default function VolcanoNumaTopologiesPage() {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const [describingName, setDescribingName] = useState<string | null>(null);

  const { data, loading, error, refresh } = useRequest(
    () => listVolcanoNumatopologies(clusterId!),
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

  const columns: ProColumns<NumatopologyRow>[] = [
    {
      title: intl.formatMessage({ id: 'pages.compute.numa.col.node' }),
      dataIndex: 'name',
      width: 220,
      fixed: 'left',
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.numa.col.policies' }),
      key: 'policies',
      width: 280,
      render: (_, r) => {
        const entries = Object.entries(r.policies ?? {});
        if (entries.length === 0)
          return <Typography.Text type="secondary">-</Typography.Text>;
        return (
          <Space size={4} wrap>
            {entries.map(([k, v]) => (
              <Tag key={k} color="cyan" style={{ marginInlineEnd: 0 }}>
                {k.replace(/Policy$/, '')}={v}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.numa.col.numaResources' }),
      key: 'numares',
      width: 320,
      render: (_, r) => {
        const list = r.numaResources ?? [];
        if (list.length === 0)
          return <Typography.Text type="secondary">-</Typography.Text>;
        return (
          <Space direction="vertical" size={2} style={{ lineHeight: 1.4 }}>
            {list.map((nr) => (
              <Tooltip key={nr.name} title={nr.allocatable || ''}>
                <Typography.Text style={{ fontSize: 12 }}>
                  <strong>{nr.name}</strong>{' '}
                  <span style={{ color: 'var(--ant-color-text-secondary)' }}>
                    capacity={nr.capacity}
                    {nr.allocatable ? ` · alloc=${nr.allocatable}` : ''}
                  </span>
                </Typography.Text>
              </Tooltip>
            ))}
          </Space>
        );
      },
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.numa.col.cpuCount' }),
      dataIndex: 'cpuCount',
      width: 90,
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.numa.col.reserved' }),
      key: 'reserved',
      width: 200,
      render: (_, r) => {
        const entries = Object.entries(r.resReserved ?? {});
        if (entries.length === 0)
          return <Typography.Text type="secondary">-</Typography.Text>;
        return (
          <Space size={4} wrap>
            {entries.map(([k, v]) => (
              <Tag key={k} style={{ marginInlineEnd: 0 }}>
                {k}={v}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.numa.col.age' }),
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
          onClick={() => setDescribingName(record.name)}
        >
          {intl.formatMessage({ id: 'pages.workloads.describe' })}
        </Button>
      ),
    },
  ];

  return (
    <div className="p-6">
      <ResourceIntro id="pages.compute.intro.numatopology" />
      {truncated && (
        <TruncatedBanner shown={items.length} count={items.length} />
      )}
      <ProTable<NumatopologyRow>
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
            <Typography.Text strong>Numatopology</Typography.Text>
            <Typography.Text type="secondary">({items.length})</Typography.Text>
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
      <DescribeDrawer
        open={!!describingName}
        onClose={() => setDescribingName(null)}
        clusterId={clusterId}
        resourceType="_cr"
        name={describingName ?? ''}
        namespace=""
        cr={NUMA_CR}
      />
    </div>
  );
}
