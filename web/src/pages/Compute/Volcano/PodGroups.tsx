import type { ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { useIntl, useModel, useParams, useRequest } from '@umijs/max';
import { App, Button, Space, Tag, Typography } from 'antd';
import React from 'react';

import {
  listVolcanoPodGroups,
  type PodGroupRow,
} from '@/services/kpilot/volcano-list';
import { deleteWorkload } from '@/services/kpilot/workload';
import {
  NotInstalled,
  RefreshControl,
  TruncatedBanner,
  formatAge,
  isResourceNotAvailable,
  useAutoRefresh,
} from './shared/Layout';

// Volcano PodGroup (`scheduling.volcano.sh/v1beta1`) — gang-scheduling
// unit. Auto-created by the Volcano Job controller, but users can also
// create standalone PodGroups for non-Job workloads. We don't expose
// a "新建" button: standalone PodGroup creation is rare and the
// generic Apply YAML drawer in 集群管理 covers it.
export default function VolcanoPodGroupsPage() {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const { message, modal } = App.useApp();
  const namespaceModel = useModel('namespace');
  const ns = clusterId ? namespaceModel.get(clusterId).selected : '';

  const { data, loading, error, refresh } = useRequest(
    () => listVolcanoPodGroups(clusterId!, ns),
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

  const onDelete = (record: PodGroupRow) => {
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
              group: 'scheduling.volcano.sh',
              version: 'v1beta1',
              kind: 'PodGroup',
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

  const columns: ProColumns<PodGroupRow>[] = [
    {
      title: intl.formatMessage({ id: 'pages.compute.podGroup.col.name' }),
      dataIndex: 'name',
      copyable: true,
      width: 220,
      fixed: 'left',
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.podGroup.col.namespace' }),
      dataIndex: 'namespace',
      width: 140,
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.podGroup.col.phase' }),
      dataIndex: 'phase',
      width: 110,
      render: (_, r) => <PodGroupPhaseTag phase={r.phase} />,
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.podGroup.col.queue' }),
      dataIndex: 'queue',
      width: 140,
      render: (_, r) => r.queue || 'default',
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.podGroup.col.minMember' }),
      dataIndex: 'minMember',
      width: 100,
    },
    {
      title: intl.formatMessage({
        id: 'pages.compute.podGroup.col.minResources',
      }),
      key: 'minResources',
      width: 220,
      render: (_, r) => formatResources(r.minResources) || '-',
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.podGroup.col.pods' }),
      key: 'pods',
      width: 200,
      render: (_, r) => (
        <Space size={4} wrap>
          {r.running > 0 && <Tag color="green">Running {r.running}</Tag>}
          {r.succeeded > 0 && (
            <Tag color="blue">Succeeded {r.succeeded}</Tag>
          )}
          {r.failed > 0 && <Tag color="red">Failed {r.failed}</Tag>}
          {r.running + r.succeeded + r.failed === 0 && (
            <Typography.Text type="secondary">-</Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.podGroup.col.age' }),
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
          onClick={() => onDelete(record)}
        >
          {intl.formatMessage({ id: 'pages.workloads.delete' })}
        </Button>
      ),
    },
  ];

  return (
    <div className="p-6">
      {truncated && (
        <TruncatedBanner shown={items.length} count={items.length} />
      )}
      <ProTable<PodGroupRow>
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
            <Typography.Text strong>PodGroup</Typography.Text>
            <Typography.Text type="secondary">
              ({items.length})
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

function PodGroupPhaseTag({ phase }: { phase: string }) {
  if (!phase) return <Tag>-</Tag>;
  const color = ((): string => {
    switch (phase) {
      case 'Running':
        return 'green';
      case 'Completed':
        return 'blue';
      case 'Pending':
      case 'Inqueue':
        return 'gold';
      case 'Failed':
        return 'red';
      case 'Unknown':
        return 'orange';
      default:
        return 'default';
    }
  })();
  return <Tag color={color}>{phase}</Tag>;
}

// formatResources for PodGroup minResources — same key ordering rule
// as the Queue page, but no allocated half (PodGroup doesn't track
// allocated; only minResources are declared on spec).
function formatResources(m?: Record<string, string>): string {
  if (!m) return '';
  const order = (k: string) => {
    if (k === 'cpu') return 0;
    if (k === 'memory') return 1;
    if (k.startsWith('volcano.sh/vgpu') || k.startsWith('nvidia.com/gpu'))
      return 2;
    return 3;
  };
  return Object.keys(m)
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    .map((k) => {
      const short = k.startsWith('volcano.sh/vgpu-')
        ? k.slice('volcano.sh/'.length)
        : k;
      return `${short} ${m[k]}`;
    })
    .join(' · ');
}
