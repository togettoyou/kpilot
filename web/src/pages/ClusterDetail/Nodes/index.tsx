import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import { ProTable } from '@ant-design/pro-components';
import { history, useParams, useRequest } from '@umijs/max';
import { Button, Layout, Menu, Space, Tag, Typography } from 'antd';
import React from 'react';
import { listNodes, type NodeInfo } from '@/services/kpilot/node';

const { Sider, Content } = Layout;
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
    return <Tag icon={<CheckCircleOutlined />} color="success">Ready</Tag>;
  if (status === 'NotReady')
    return <Tag icon={<CloseCircleOutlined />} color="error">NotReady</Tag>;
  return <Tag icon={<QuestionCircleOutlined />} color="default">Unknown</Tag>;
};

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

  const { data, loading } = useRequest(
    () => listNodes(clusterId!),
    { pollingInterval: 15000 },
  );

  const nodes: NodeInfo[] = Array.isArray(data) ? data : [];

  const sideMenuItems = [
    { key: 'nodes', label: 'Nodes' },
    { key: 'workloads', label: 'Workloads', disabled: true },
    { key: 'plugins', label: 'Plugins', disabled: true },
    { key: 'gpu', label: 'GPU', disabled: true },
    { key: 'models', label: 'Models', disabled: true },
    { key: 'monitoring', label: 'Monitoring', disabled: true },
    { key: 'logging', label: 'Logging', disabled: true },
  ];

  return (
    <Layout className="min-h-screen">
      <Sider width={200} theme="light" className="border-r border-gray-100">
        <div className="p-4 border-b border-gray-100">
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={() => history.push('/clusters')}
            size="small"
          >
            Clusters
          </Button>
        </div>
        <Menu
          mode="inline"
          selectedKeys={['nodes']}
          items={sideMenuItems}
          className="border-0"
        />
      </Sider>

      <Content className="p-6 bg-gray-50">
        <ProTable<NodeInfo>
          headerTitle={
            <Space>
              <Text strong>Nodes</Text>
              <Text type="secondary">({nodes.length})</Text>
            </Space>
          }
          rowKey="name"
          loading={loading}
          dataSource={nodes}
          search={false}
          pagination={false}
          options={{ reload: false }}
          columns={[
            {
              title: 'Name',
              dataIndex: 'name',
              width: 200,
            },
            {
              title: 'Status',
              dataIndex: 'status',
              width: 110,
              render: (_, record) => <NodeStatus status={record.status} />,
            },
            {
              title: 'CPU (alloc / total)',
              width: 160,
              render: (_, r) =>
                `${formatCPU(r.cpu_allocatable)} / ${formatCPU(r.cpu_capacity)}`,
            },
            {
              title: 'Memory (alloc / total)',
              width: 180,
              render: (_, r) =>
                `${formatMemory(r.memory_allocatable)} / ${formatMemory(r.memory_capacity)}`,
            },
            {
              title: 'GPU Model',
              width: 180,
              render: (_, r) => {
                const { model } = getGPUInfo(r.labels);
                return model
                  ? <Tag color="purple">{model}</Tag>
                  : <Text type="secondary">—</Text>;
              },
            },
            {
              title: 'GPU Count',
              width: 100,
              render: (_, r) => {
                const { count } = getGPUInfo(r.labels);
                return count ?? <Text type="secondary">—</Text>;
              },
            },
          ]}
        />
      </Content>
    </Layout>
  );
}
