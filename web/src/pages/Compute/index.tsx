import {
  CheckCircleFilled,
  CloseCircleFilled,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { history, useIntl, useRequest } from '@umijs/max';
import { Button, Card, Empty, Space, Spin, Tag, Typography } from 'antd';
import React from 'react';

import { type Cluster, listClusters } from '@/services/kpilot/cluster';

const { Text, Paragraph } = Typography;

// Compute landing page — pick a cluster to enter the GPU ops view.
// Lighter version of the /clusters page: same card grid look but no
// create/edit/delete actions (those live on /clusters; this page only
// selects a cluster context for the compute platform).
const ComputeLanding: React.FC = () => {
  const intl = useIntl();
  const { data, loading } = useRequest(listClusters, {
    pollingInterval: 10_000,
    formatResult: (res) => res,
    pollingWhenHidden: false,
  });
  const clusters: Cluster[] = Array.isArray(data) ? data : [];

  const enter = (id: string) => history.push(`/compute/${id}/overview`);

  return (
    <PageContainer
      header={{
        title: intl.formatMessage({ id: 'pages.compute.landing.title' }),
        subTitle: intl.formatMessage({ id: 'pages.compute.landing.subtitle' }),
      }}
    >
      {loading && clusters.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
          <Spin />
        </div>
      ) : clusters.length === 0 ? (
        <Card>
          <Empty
            description={
              <Space direction="vertical" size={4}>
                <Text strong>
                  {intl.formatMessage({ id: 'pages.compute.landing.empty.title' })}
                </Text>
                <Text type="secondary">
                  {intl.formatMessage({ id: 'pages.compute.landing.empty.hint' })}
                </Text>
              </Space>
            }
          >
            <Button type="primary" onClick={() => history.push('/clusters')}>
              {intl.formatMessage({ id: 'pages.compute.landing.empty.action' })}
            </Button>
          </Empty>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {clusters.map((c) => (
            <PickerCard key={c.id} cluster={c} onEnter={() => enter(c.id)} />
          ))}
        </div>
      )}
    </PageContainer>
  );
};

const PickerCard: React.FC<{ cluster: Cluster; onEnter: () => void }> = ({
  cluster,
  onEnter,
}) => {
  const intl = useIntl();
  const online = cluster.status === 'online';
  return (
    <Card
      hoverable
      onClick={onEnter}
      styles={{ body: { padding: 16 } }}
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space size={8}>
            <ThunderboltOutlined style={{ color: '#1677ff', fontSize: 18 }} />
            <Text strong style={{ fontSize: 15 }}>
              {cluster.name}
            </Text>
          </Space>
          {online ? (
            <Tag color="success" icon={<CheckCircleFilled />}>
              {intl.formatMessage({ id: 'pages.clusters.status.online' })}
            </Tag>
          ) : (
            <Tag icon={<CloseCircleFilled />}>
              {intl.formatMessage({ id: 'pages.clusters.status.offline' })}
            </Tag>
          )}
        </div>
        <Paragraph
          type="secondary"
          ellipsis={{ rows: 2 }}
          style={{ marginBottom: 0, minHeight: 40 }}
        >
          {cluster.description ||
            intl.formatMessage({ id: 'pages.clusters.card.noDescription' })}
        </Paragraph>
      </Space>
    </Card>
  );
};

export default ComputeLanding;
