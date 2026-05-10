import {
  CheckCircleFilled,
  CloseCircleFilled,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { history, useIntl, useRequest } from '@umijs/max';
import { Button, Card, Empty, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import React from 'react';

import { type Cluster, listClusters } from '@/services/kpilot/cluster';

const { Text } = Typography;

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

  // Land on /scheduler — the platform's default tab after the
  // Volcano pivot dropped the GPU overview page.
  const enter = (id: string) => history.push(`/compute/${id}/scheduler`);

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
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {/* min-width:0 + flex:1 lets the name truncate instead of
              pushing the status tag offscreen on long cluster names. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minWidth: 0,
              flex: 1,
            }}
          >
            <ThunderboltOutlined
              style={{ color: '#1677ff', fontSize: 18, flexShrink: 0 }}
            />
            {/* Pure-CSS truncate + native browser tooltip via the
                `title` attr. antd's Text ellipsis={{ tooltip }} +
                hoverable Card combination flickered: hovering moved
                the card slightly, antd's resize observer
                re-measured, the tooltip rebound, and the cycle
                repeated. Native title is zero-JS, no observer. */}
            <span
              title={cluster.name}
              style={{
                fontWeight: 600,
                fontSize: 15,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
            >
              {cluster.name}
            </span>
          </div>
          {online ? (
            <Tag color="success" icon={<CheckCircleFilled />} style={{ flexShrink: 0 }}>
              {intl.formatMessage({ id: 'pages.clusters.status.online' })}
            </Tag>
          ) : (
            <Tag icon={<CloseCircleFilled />} style={{ flexShrink: 0 }}>
              {intl.formatMessage({ id: 'pages.clusters.status.offline' })}
            </Tag>
          )}
        </div>
        {/* CSS line-clamp keeps the card height stable. When the
            description overflows the 2-line clamp, hover shows the
            full text inside an antd Tooltip — overlayInnerStyle caps
            the popup at 280px tall and scrolls inside, so a 2000-
            character description doesn't paint half the screen. */}
        <Tooltip
          title={cluster.description}
          placement="topLeft"
          overlayInnerStyle={{
            maxHeight: 280,
            overflowY: 'auto',
            wordBreak: 'break-all',
          }}
        >
          <div
            style={{
              color: 'var(--ant-color-text-secondary)',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              wordBreak: 'break-all',
              minHeight: 40,
            }}
          >
            {cluster.description ||
              intl.formatMessage({ id: 'pages.clusters.card.noDescription' })}
          </div>
        </Tooltip>
      </Space>
    </Card>
  );
};

export default ComputeLanding;
