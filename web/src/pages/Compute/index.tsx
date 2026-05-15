import {
  CheckCircleOutlined,
  MinusCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { history, useIntl, useRequest } from '@umijs/max';
import { Button, Card, Empty, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import React from 'react';

import { type Cluster, listClusters } from '@/services/kpilot/cluster';

const { Text } = Typography;

// Compute landing page — pick a cluster to enter the GPU ops view.
// Visual chrome mirrors the /clusters page (title + extra header,
// description body with min-height, dates row at the bottom) so the
// two landing pages feel like the same product. Differences vs
// /clusters: no create / edit / delete affordances (cluster
// lifecycle lives on /clusters; this page only picks a context).
const ComputeLanding: React.FC = () => {
  const intl = useIntl();
  const { data, loading } = useRequest(listClusters, {
    pollingInterval: 10_000,
    formatResult: (res) => res,
    pollingWhenHidden: false,
  });
  const clusters: Cluster[] = Array.isArray(data) ? data : [];

  // Land on /overview — the Volcano dashboard. Users get a cluster-
  // wide health snapshot first; /scheduler is one click away in the
  // sider for config-only tasks.
  const enter = (id: string) => history.push(`/compute/${id}/overview`);

  return (
    <PageContainer
      header={{
        title: intl.formatMessage({ id: 'pages.compute.landing.title' }),
        subTitle: intl.formatMessage({ id: 'pages.compute.landing.subtitle' }),
      }}
    >
      {loading && clusters.length === 0 ? (
        <div className="flex justify-center py-20">
          <Spin size="large" />
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
        // Same breakpoint ladder as /clusters: 1 / 2 / 3 columns. The
        // older `xl:grid-cols-4` cap made cards too narrow on common
        // 1440-wide laptops — the description got cut to fewer than
        // half its 2 lines.
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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

  // Show date + time — matches /clusters so a user comparing the two
  // pages side-by-side sees consistent footer info.
  const formatDate = (iso: string) => new Date(iso).toLocaleString();

  return (
    <Card
      hoverable
      onClick={onEnter}
      title={
        // Flex with min-width:0 on the name so long cluster names
        // truncate instead of pushing the status tag offscreen.
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 0,
          }}
        >
          <ThunderboltOutlined
            className="text-blue-500"
            style={{ flexShrink: 0 }}
          />
          <Text
            strong
            ellipsis={{ tooltip: cluster.name }}
            style={{ minWidth: 0, flex: 1 }}
          >
            {cluster.name}
          </Text>
          <Tag
            color={online ? 'success' : 'default'}
            icon={online ? <CheckCircleOutlined /> : <MinusCircleOutlined />}
            style={{ flexShrink: 0, marginInlineEnd: 0 }}
          >
            {intl.formatMessage({
              id: online
                ? 'pages.clusters.status.online'
                : 'pages.clusters.status.offline',
            })}
          </Tag>
        </div>
      }
    >
      {/* Description — CSS line-clamp keeps card heights aligned.
          Long descriptions reveal in a Tooltip on hover, capped at
          280 px tall and scrollable inside, so a multi-paragraph
          description doesn't paint half the screen. */}
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
          className="mb-3 min-h-[44px]"
          style={{
            color: 'var(--ant-color-text-secondary)',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            wordBreak: 'break-all',
          }}
        >
          {cluster.description ||
            intl.formatMessage({ id: 'pages.clusters.card.noDescription' })}
        </div>
      </Tooltip>
      {/* Created / updated side-by-side, single line. Same shape as
          /clusters' ClusterCard so the footer reads consistently. */}
      <div
        className="flex justify-between text-xs text-gray-400"
        style={{ gap: 12, whiteSpace: 'nowrap' }}
      >
        <span>
          {intl.formatMessage(
            { id: 'pages.clusters.card.createdAt' },
            { date: formatDate(cluster.created_at) },
          )}
        </span>
        <span>
          {intl.formatMessage(
            { id: 'pages.clusters.card.updatedAt' },
            { date: formatDate(cluster.updated_at) },
          )}
        </span>
      </div>
    </Card>
  );
};

export default ComputeLanding;
