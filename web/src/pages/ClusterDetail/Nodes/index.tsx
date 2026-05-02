import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import { ProTable } from '@ant-design/pro-components';
import { useIntl, useParams, useRequest } from '@umijs/max';
import { Descriptions, Space, Tag, Typography } from 'antd';
import React from 'react';
import { listNodes, type NodeInfo } from '@/services/kpilot/node';

const { Text } = Typography;

function formatCPU(millicores: number): string {
  if (millicores >= 1000) return `${(millicores / 1000).toFixed(1)} cores`;
  return `${millicores}m`;
}

function formatMemory(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} Gi`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} Mi`;
  return `${bytes} B`;
}

const NodeStatus: React.FC<{ status: NodeInfo['status'] }> = ({ status }) => {
  if (status === 'Ready')
    return (
      <Tag icon={<CheckCircleOutlined />} color="success">
        Ready
      </Tag>
    );
  if (status === 'NotReady')
    return (
      <Tag icon={<CloseCircleOutlined />} color="error">
        NotReady
      </Tag>
    );
  return (
    <Tag icon={<QuestionCircleOutlined />} color="default">
      Unknown
    </Tag>
  );
};

function getNodeRole(
  labels: Record<string, string>,
): 'control-plane' | 'worker' {
  if (
    labels['node-role.kubernetes.io/control-plane'] === 'true' ||
    labels['node-role.kubernetes.io/master'] === 'true'
  ) {
    return 'control-plane';
  }
  return 'worker';
}

function getArch(labels: Record<string, string>): string {
  return (
    labels['kubernetes.io/arch'] || labels['beta.kubernetes.io/arch'] || ''
  );
}

function getOS(labels: Record<string, string>): string {
  return labels['kubernetes.io/os'] || labels['beta.kubernetes.io/os'] || '';
}

function getGPUInfo(labels: Record<string, string>) {
  const model =
    labels['nvidia.com/gpu.product'] ||
    labels['gpu.product'] ||
    labels['hami.io/gpu-product'] ||
    null;
  const count =
    labels['nvidia.com/gpu.count'] ||
    labels['gpu.count'] ||
    labels['hami.io/gpu-count'] ||
    null;
  return { model, count };
}

export default function NodesPage() {
  const { id: clusterId } = useParams<{ id: string }>();
  const intl = useIntl();

  const { data, loading } = useRequest(() => listNodes(clusterId!), {
    pollingInterval: 15000,
    formatResult: (res) => res,
    pollingWhenHidden: false,
  });
  const nodes: NodeInfo[] = Array.isArray(data) ? data : [];

  return (
    <div className="p-6">
      <ProTable<NodeInfo>
        expandable={{
          expandedRowRender: (record) => (
            <div className="p-4 flex flex-col gap-4">
              <Descriptions
                size="small"
                column={3}
                bordered
                items={[
                  {
                    key: 'ip',
                    label: intl.formatMessage({ id: 'pages.nodes.detail.ip' }),
                    children: record.internal_ip || '—',
                  },
                  {
                    key: 'podCIDR',
                    label: intl.formatMessage({
                      id: 'pages.nodes.detail.podCIDR',
                    }),
                    children: record.pod_cidr || '—',
                  },
                  {
                    key: 'os',
                    label: intl.formatMessage({ id: 'pages.nodes.detail.os' }),
                    children: record.os_image || '—',
                  },
                  {
                    key: 'kernel',
                    label: intl.formatMessage({
                      id: 'pages.nodes.detail.kernel',
                    }),
                    children: record.kernel_version || '—',
                  },
                  {
                    key: 'runtime',
                    label: intl.formatMessage({
                      id: 'pages.nodes.detail.runtime',
                    }),
                    children: record.container_runtime || '—',
                  },
                  {
                    key: 'kubelet',
                    label: intl.formatMessage({
                      id: 'pages.nodes.detail.kubelet',
                    }),
                    children: record.kubelet_version || '—',
                  },
                ]}
              />
              <div className="grid grid-cols-2 gap-4">
                <Descriptions
                  title="Labels"
                  size="small"
                  column={1}
                  bordered
                  items={Object.entries(record.labels).map(([k, v]) => ({
                    key: k,
                    label: k,
                    children: v,
                  }))}
                />
                <Descriptions
                  title="Annotations"
                  size="small"
                  column={1}
                  bordered
                  items={Object.entries(record.annotations ?? {}).map(
                    ([k, v]) => ({ key: k, label: k, children: v }),
                  )}
                />
              </div>
            </div>
          ),
        }}
        headerTitle={
          <Space>
            <Text strong>
              {intl.formatMessage({ id: 'pages.nodes.title' })}
            </Text>
            <Text type="secondary">({nodes.length})</Text>
          </Space>
        }
        rowKey="name"
        loading={loading}
        dataSource={nodes}
        scroll={{ x: 'max-content' }}
        search={false}
        pagination={false}
        options={{ reload: false }}
        columns={[
          {
            title: intl.formatMessage({ id: 'pages.nodes.col.name' }),
            dataIndex: 'name',
            width: 200,
          },
          {
            title: intl.formatMessage({ id: 'pages.nodes.col.status' }),
            dataIndex: 'status',
            width: 110,
            render: (_, record) => <NodeStatus status={record.status} />,
          },
          {
            title: intl.formatMessage({ id: 'pages.nodes.col.role' }),
            width: 130,
            render: (_, record) => {
              const role = getNodeRole(record.labels);
              return role === 'control-plane' ? (
                <Tag color="blue">control-plane</Tag>
              ) : (
                <Tag color="default">worker</Tag>
              );
            },
          },
          {
            title: intl.formatMessage({ id: 'pages.nodes.col.osArch' }),
            width: 130,
            render: (_, record) => {
              const os = getOS(record.labels);
              const arch = getArch(record.labels);
              if (!os && !arch) return <Text type="secondary">—</Text>;
              return <Text>{[os, arch].filter(Boolean).join(' / ')}</Text>;
            },
          },
          {
            title: intl.formatMessage({ id: 'pages.nodes.col.cpu' }),
            width: 180,
            render: (_, r) =>
              `${formatCPU(r.cpu_allocatable)} / ${formatCPU(r.cpu_capacity)}`,
          },
          {
            title: intl.formatMessage({ id: 'pages.nodes.col.memory' }),
            width: 200,
            render: (_, r) =>
              `${formatMemory(r.memory_allocatable)} / ${formatMemory(r.memory_capacity)}`,
          },
          {
            title: intl.formatMessage({ id: 'pages.nodes.col.gpuModel' }),
            width: 180,
            render: (_, r) => {
              const { model } = getGPUInfo(r.labels);
              return model ? (
                <Tag color="purple">{model}</Tag>
              ) : (
                <Text type="secondary">—</Text>
              );
            },
          },
          {
            title: intl.formatMessage({ id: 'pages.nodes.col.gpuCount' }),
            width: 100,
            render: (_, r) => {
              const { count } = getGPUInfo(r.labels);
              return count ?? <Text type="secondary">—</Text>;
            },
          },
        ]}
      />
    </div>
  );
}
