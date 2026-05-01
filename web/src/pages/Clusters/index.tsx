import {
  CheckCircleOutlined,
  ClusterOutlined,
  DeleteOutlined,
  MinusCircleOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import { history, useRequest } from '@umijs/max';
import {
  App,
  Badge,
  Button,
  Form,
  Input,
  Modal,
  Space,
  Tag,
  Typography,
} from 'antd';
import React, { useState } from 'react';
import {
  createCluster,
  deleteCluster,
  listClusters,
  type Cluster,
  type CreateClusterResult,
} from '@/services/kpilot/cluster';

const { Text, Paragraph } = Typography;

const StatusBadge: React.FC<{ status: Cluster['status'] }> = ({ status }) => {
  if (status === 'online') {
    return (
      <Badge
        status="success"
        text={<Tag icon={<CheckCircleOutlined />} color="success">Online</Tag>}
      />
    );
  }
  return (
    <Badge
      status="default"
      text={<Tag icon={<MinusCircleOutlined />} color="default">Offline</Tag>}
    />
  );
};

const TokenModal: React.FC<{
  result: CreateClusterResult;
  onClose: () => void;
}> = ({ result, onClose }) => {
  const { message } = App.useApp();

  const workerYaml = `apiVersion: v1
kind: Namespace
metadata:
  name: kpilot-system
---
apiVersion: v1
kind: Secret
metadata:
  name: kpilot-worker-secret
  namespace: kpilot-system
stringData:
  CLUSTER_TOKEN: "${result.token}"
  SERVER_ADDR: "your-server-grpc-addr:9090"`;

  return (
    <Modal
      open
      title="Cluster Created"
      onCancel={onClose}
      footer={<Button type="primary" onClick={onClose}>Done</Button>}
      width={640}
    >
      <Space direction="vertical" className="w-full" size="middle">
        <Text type="warning">
          ⚠️ Save this token now — it will <strong>not</strong> be shown again.
        </Text>
        <div>
          <Text strong>Cluster Token</Text>
          <Paragraph
            copyable={{ onCopy: () => message.success('Copied!') }}
            code
            className="mt-1 break-all"
          >
            {result.token}
          </Paragraph>
        </div>
        <div>
          <Text strong>Worker Deployment YAML</Text>
          <Paragraph
            copyable={{
              text: workerYaml,
              onCopy: () => message.success('YAML copied!'),
            }}
            className="mt-1"
          >
            <pre className="bg-gray-50 p-3 rounded text-xs overflow-auto max-h-48">
              {workerYaml}
            </pre>
          </Paragraph>
        </div>
      </Space>
    </Modal>
  );
};

export default function ClustersPage() {
  const { modal, message } = App.useApp();
  const [createVisible, setCreateVisible] = useState(false);
  const [tokenResult, setTokenResult] = useState<CreateClusterResult | null>(null);
  const [form] = Form.useForm();

  const { data: clusters, loading, refresh } = useRequest(listClusters, {
    pollingInterval: 10000,
  });

  const clusterList: Cluster[] = Array.isArray(clusters) ? clusters : [];

  const { loading: creating, run: doCreate } = useRequest(createCluster, {
    manual: true,
    onSuccess: (result) => {
      setCreateVisible(false);
      form.resetFields();
      setTokenResult(result as CreateClusterResult);
      refresh();
    },
    onError: (err) => {
      message.error(err.message || 'Failed to create cluster');
    },
  });

  const handleDelete = (record: Cluster) => {
    modal.confirm({
      title: `Delete cluster "${record.name}"?`,
      content: 'This will disconnect the Worker and remove all cluster data.',
      okType: 'danger',
      onOk: async () => {
        await deleteCluster(record.id);
        message.success('Cluster deleted');
        refresh();
      },
    });
  };

  return (
    <PageContainer
      header={{ title: 'Clusters', subTitle: 'Manage your Kubernetes clusters' }}
      extra={
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setCreateVisible(true)}
        >
          Add Cluster
        </Button>
      }
    >
      <ProTable<Cluster>
        rowKey="id"
        loading={loading}
        dataSource={clusterList}
        search={false}
        toolBarRender={false}
        pagination={false}
        columns={[
          {
            title: 'Name',
            dataIndex: 'name',
            render: (_, record) => (
              <a onClick={() => history.push(`/clusters/${record.id}/nodes`)}>
                <ClusterOutlined className="mr-1" />
                {record.name}
              </a>
            ),
          },
          {
            title: 'Status',
            dataIndex: 'status',
            width: 140,
            render: (_, record) => <StatusBadge status={record.status} />,
          },
          {
            title: 'Description',
            dataIndex: 'description',
            ellipsis: true,
          },
          {
            title: 'Created',
            dataIndex: 'created_at',
            width: 180,
            render: (_, record) => new Date(record.created_at).toLocaleString(),
          },
          {
            title: 'Action',
            width: 80,
            render: (_, record) => (
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => handleDelete(record)}
              />
            ),
          },
        ]}
      />

      <Modal
        title="Add Cluster"
        open={createVisible}
        onCancel={() => { setCreateVisible(false); form.resetFields(); }}
        onOk={() => form.submit()}
        confirmLoading={creating}
        okText="Create"
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => doCreate(values)}
          className="mt-4"
        >
          <Form.Item
            name="name"
            label="Cluster Name"
            rules={[{ required: true, message: 'Please enter cluster name' }]}
          >
            <Input placeholder="e.g. prod-cluster-01" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} placeholder="Optional description" />
          </Form.Item>
        </Form>
      </Modal>

      {tokenResult && (
        <TokenModal
          result={tokenResult}
          onClose={() => setTokenResult(null)}
        />
      )}
    </PageContainer>
  );
}
