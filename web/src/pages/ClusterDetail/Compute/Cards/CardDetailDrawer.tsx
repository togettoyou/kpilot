import { useIntl } from '@umijs/max';
import { Col, Descriptions, Drawer, Progress, Row, Space, Table, Tag, Typography } from 'antd';
import React from 'react';

import type { GPUCardSummary } from '@/services/kpilot/gpu';

import { formatMB } from '../format';

interface Props {
  card: GPUCardSummary | null;
  nodeName: string;
  open: boolean;
  onClose: () => void;
}

// CardDetailDrawer is the per-physical-card view: the same content as
// the inline card section in the original combined page, but reachable
// from both the Nodes detail (via NodeDetailDrawer) and the Cards page.
const CardDetailDrawer: React.FC<Props> = ({ card, nodeName, open, onClose }) => {
  const intl = useIntl();
  if (!card) return null;
  const memPct = card.devmem > 0 ? Math.round((card.usedMem / card.devmem) * 100) : 0;
  const corePct = card.devcore > 0 ? Math.round((card.usedCores / card.devcore) * 100) : 0;
  const slotPct = card.slots > 0 ? Math.round((card.usedSlots / card.slots) * 100) : 0;
  const pods = card.pods ?? [];

  return (
    <Drawer
      title={
        <Space>
          <span style={{ fontWeight: 600 }}>{card.type}</span>
          {card.health ? (
            <Tag color="success">
              {intl.formatMessage({ id: 'pages.gpu.node.devices.health.ok' })}
            </Tag>
          ) : (
            <Tag color="error">
              {intl.formatMessage({ id: 'pages.gpu.node.devices.health.bad' })}
            </Tag>
          )}
        </Space>
      }
      open={open}
      onClose={onClose}
      maskClosable={false}
      size="large"
    >
      <Descriptions
        column={1}
        size="small"
        bordered
        style={{ marginBottom: 16 }}
        items={[
          {
            label: intl.formatMessage({ id: 'pages.compute.cards.col.uuid' }),
            children: <Typography.Text code copyable={{ text: card.uuid }}>{card.uuid}</Typography.Text>,
          },
          {
            label: intl.formatMessage({ id: 'pages.compute.cards.col.node' }),
            children: nodeName,
          },
          {
            label: 'NUMA',
            children: card.numa,
          },
        ]}
      />
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={24} md={8}>
          <Typography.Text type="secondary">
            {intl.formatMessage({ id: 'pages.gpu.card.slots' })}
          </Typography.Text>
          <Progress percent={slotPct} format={() => `${card.usedSlots} / ${card.slots}`} />
        </Col>
        <Col xs={24} md={8}>
          <Typography.Text type="secondary">
            {intl.formatMessage({ id: 'pages.gpu.card.memory' })}
          </Typography.Text>
          <Progress
            percent={memPct}
            format={() => `${formatMB(card.usedMem)} / ${formatMB(card.devmem)}`}
          />
        </Col>
        <Col xs={24} md={8}>
          <Typography.Text type="secondary">
            {intl.formatMessage({ id: 'pages.gpu.card.cores' })}
          </Typography.Text>
          <Progress
            percent={corePct}
            format={() => `${card.usedCores}% / ${card.devcore}%`}
          />
        </Col>
      </Row>
      <Typography.Title level={5}>
        {intl.formatMessage({ id: 'pages.gpu.node.pods' })}
      </Typography.Title>
      {pods.length === 0 ? (
        <Typography.Text type="secondary">
          {intl.formatMessage({ id: 'pages.gpu.card.idle' })}
        </Typography.Text>
      ) : (
        <Table
          size="small"
          rowKey={(r) => `${r.namespace}/${r.name}`}
          pagination={false}
          dataSource={pods}
          columns={[
            {
              title: intl.formatMessage({ id: 'pages.gpu.node.pods.namespace' }),
              dataIndex: 'namespace',
            },
            {
              title: intl.formatMessage({ id: 'pages.gpu.node.pods.name' }),
              dataIndex: 'name',
            },
            {
              title: intl.formatMessage({ id: 'pages.gpu.card.podMem' }),
              dataIndex: 'mem',
              width: 120,
              align: 'right',
              render: (v: number) => formatMB(v),
            },
            {
              title: intl.formatMessage({ id: 'pages.gpu.card.podCores' }),
              dataIndex: 'cores',
              width: 100,
              align: 'right',
              render: (v: number) => `${v}%`,
            },
          ]}
        />
      )}
    </Drawer>
  );
};

export default CardDetailDrawer;
