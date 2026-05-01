import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import { ProTable } from '@ant-design/pro-components';
import { history, useIntl, useParams, useRequest } from '@umijs/max';
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
  const intl = useIntl();

  const { data, loading } = useRequest(
    () => listNodes(clusterId!),
    { pollingInterval: 15000 },
  );
  const nodes: NodeInfo[] = Array.isArray(data) ? data : [];

  const sideMenuItems = [
    { key: 'nodes',      label: intl.formatMessage({ id: 'pages.cluster.nav.nodes' }) },
    { key: 'workloads',  label: intl.formatMessage({ id: 'pages.cluster.nav.workloads' }),  disabled: true },
    { key: 'plugins',    label: intl.formatMessage({ id: 'pages.cluster.nav.plugins' }),    disabled: true },
    { key: 'gpu',        label: intl.formatMessage({ id: 'pages.cluster.nav.gpu' }),        disabled: true },
    { key: 'models',     label: intl.formatMessage({ id: 'pages.cluster.nav.models' }),     disabled: true },
    { key: 'monitoring', label: intl.formatMessage({ id: 'pages.cluster.nav.monitoring' }), disabled: true },
    { key: 'logging',    label: intl.formatMessage({ id: 'pages.cluster.nav.logging' }),    disabled: true },
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
            {intl.formatMessage({ id: 'pages.cluster.back' })}
          </Button>
        </div>
        <Menu mode="inline" selectedKeys={['nodes']} items={sideMenuItems} className="border-0" />
      </Sider>

      <Content className="p-6 bg-gray-50">
        <ProTable<NodeInfo>
          headerTitle={
            <Space>
              <Text strong>{intl.formatMessage({ id: 'pages.nodes.title' })}</Text>
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
              title: intl.formatMessage({ id: 'pages.nodes.col.cpu' }),
              width: 180,
              render: (_, r) => `${formatCPU(r.cpu_allocatable)} / ${formatCPU(r.cpu_capacity)}`,
            },
            {
              title: intl.formatMessage({ id: 'pages.nodes.col.memory' }),
              width: 200,
              render: (_, r) => `${formatMemory(r.memory_allocatable)} / ${formatMemory(r.memory_capacity)}`,
            },
            {
              title: intl.formatMessage({ id: 'pages.nodes.col.gpuModel' }),
              width: 180,
              render: (_, r) => {
                const { model } = getGPUInfo(r.labels);
                return model ? <Tag color="purple">{model}</Tag> : <Text type="secondary">—</Text>;
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
      </Content>
    </Layout>
  );
}
