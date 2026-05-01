import {
  CheckCircleOutlined,
  ClusterOutlined,
  DeleteOutlined,
  MinusCircleOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import { history, useIntl, useRequest } from '@umijs/max';
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

const StatusBadge: React.FC<{ status: Cluster['status']; onlineLabel: string; offlineLabel: string }> = ({
  status, onlineLabel, offlineLabel,
}) => {
  if (status === 'online') {
    return (
      <Badge status="success" text={
        <Tag icon={<CheckCircleOutlined />} color="success">{onlineLabel}</Tag>
      } />
    );
  }
  return (
    <Badge status="default" text={
      <Tag icon={<MinusCircleOutlined />} color="default">{offlineLabel}</Tag>
    } />
  );
};

const TokenModal: React.FC<{ result: CreateClusterResult; onClose: () => void }> = ({
  result, onClose,
}) => {
  const { message } = App.useApp();
  const intl = useIntl();

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
      title={intl.formatMessage({ id: 'pages.clusters.token.title' })}
      onCancel={onClose}
      footer={
        <Button type="primary" onClick={onClose}>
          {intl.formatMessage({ id: 'pages.clusters.token.done' })}
        </Button>
      }
      width={640}
    >
      <Space direction="vertical" className="w-full" size="middle">
        <Text type="warning">
          ⚠️ {intl.formatMessage({ id: 'pages.clusters.token.warning' })}
        </Text>
        <div>
          <Text strong>{intl.formatMessage({ id: 'pages.clusters.token.label' })}</Text>
          <Paragraph
            copyable={{ onCopy: () => message.success(intl.formatMessage({ id: 'pages.clusters.copied' })) }}
            code
            className="mt-1 break-all"
          >
            {result.token}
          </Paragraph>
        </div>
        <div>
          <Text strong>{intl.formatMessage({ id: 'pages.clusters.token.yamlLabel' })}</Text>
          <Paragraph
            copyable={{
              text: workerYaml,
              onCopy: () => message.success(intl.formatMessage({ id: 'pages.clusters.yamlCopied' })),
            }}
            className="mt-1"
          >
            <pre className="bg-gray-50 p-3 rounded text-xs overflow-auto max-h-48">{workerYaml}</pre>
          </Paragraph>
        </div>
      </Space>
    </Modal>
  );
};

export default function ClustersPage() {
  const { modal, message } = App.useApp();
  const intl = useIntl();
  const [createVisible, setCreateVisible] = useState(false);
  const [tokenResult, setTokenResult] = useState<CreateClusterResult | null>(null);
  const [form] = Form.useForm();

  const { data: clusters, loading, refresh } = useRequest(listClusters, {
    pollingInterval: 10000,
    formatResult: (res) => res,
  });
  const clusterList: Cluster[] = Array.isArray(clusters) ? clusters : [];

  const { loading: creating, run: doCreate } = useRequest(createCluster, {
    manual: true,
    formatResult: (res) => res,
    onSuccess: (result) => {
      setCreateVisible(false);
      form.resetFields();
      setTokenResult(result as CreateClusterResult);
      refresh();
    },
    onError: () => {
      message.error(intl.formatMessage({ id: 'pages.clusters.create.error' }));
    },
  });

  const handleDelete = (record: Cluster) => {
    modal.confirm({
      title: intl.formatMessage({ id: 'pages.clusters.delete.title' }, { name: record.name }),
      content: intl.formatMessage({ id: 'pages.clusters.delete.content' }),
      okType: 'danger',
      onOk: async () => {
        await deleteCluster(record.id);
        message.success(intl.formatMessage({ id: 'pages.clusters.delete.success' }));
        refresh();
      },
    });
  };

  const onlineLabel = intl.formatMessage({ id: 'pages.clusters.status.online' });
  const offlineLabel = intl.formatMessage({ id: 'pages.clusters.status.offline' });

  return (
    <PageContainer
      header={{
        title: intl.formatMessage({ id: 'pages.clusters.title' }),
        subTitle: intl.formatMessage({ id: 'pages.clusters.subtitle' }),
      }}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateVisible(true)}>
          {intl.formatMessage({ id: 'pages.clusters.addCluster' })}
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
            title: intl.formatMessage({ id: 'pages.clusters.col.name' }),
            dataIndex: 'name',
            render: (_, record) => (
              <a onClick={() => history.push(`/clusters/${record.id}/nodes`)}>
                <ClusterOutlined className="mr-1" />
                {record.name}
              </a>
            ),
          },
          {
            title: intl.formatMessage({ id: 'pages.clusters.col.status' }),
            dataIndex: 'status',
            width: 140,
            render: (_, record) => (
              <StatusBadge status={record.status} onlineLabel={onlineLabel} offlineLabel={offlineLabel} />
            ),
          },
          {
            title: intl.formatMessage({ id: 'pages.clusters.col.description' }),
            dataIndex: 'description',
            ellipsis: true,
          },
          {
            title: intl.formatMessage({ id: 'pages.clusters.col.createdAt' }),
            dataIndex: 'created_at',
            width: 180,
            render: (_, record) => new Date(record.created_at).toLocaleString(),
          },
          {
            title: intl.formatMessage({ id: 'pages.clusters.col.action' }),
            width: 80,
            render: (_, record) => (
              <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record)} />
            ),
          },
        ]}
      />

      <Modal
        title={intl.formatMessage({ id: 'pages.clusters.modal.add' })}
        open={createVisible}
        onCancel={() => { setCreateVisible(false); form.resetFields(); }}
        onOk={() => form.submit()}
        confirmLoading={creating}
        okText={intl.formatMessage({ id: 'pages.clusters.modal.create' })}
      >
        <Form form={form} layout="vertical" onFinish={(values) => doCreate(values)} className="mt-4">
          <Form.Item
            name="name"
            label={intl.formatMessage({ id: 'pages.clusters.modal.name' })}
            rules={[{ required: true, message: intl.formatMessage({ id: 'pages.clusters.modal.nameRequired' }) }]}
          >
            <Input placeholder={intl.formatMessage({ id: 'pages.clusters.modal.namePlaceholder' })} />
          </Form.Item>
          <Form.Item name="description" label={intl.formatMessage({ id: 'pages.clusters.modal.description' })}>
            <Input.TextArea rows={2} placeholder={intl.formatMessage({ id: 'pages.clusters.modal.descPlaceholder' })} />
          </Form.Item>
        </Form>
      </Modal>

      {tokenResult && (
        <TokenModal result={tokenResult} onClose={() => setTokenResult(null)} />
      )}
    </PageContainer>
  );
}
