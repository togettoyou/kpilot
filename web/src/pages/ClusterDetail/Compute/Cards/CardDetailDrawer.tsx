import { useIntl } from '@umijs/max';
import { Descriptions, Drawer, Space, Tag, Typography } from 'antd';
import React from 'react';

import type { GPUCardSummary } from '@/services/kpilot/gpu';

import CardBody from '../CardBody';

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
      {/* The drawer adds its own context (UUID copy / node / NUMA) on
          top of the shared CardBody — useful here because the user
          opened this drawer from a flat list and needs to know which
          node the card belongs to. NodeDetailDrawer doesn't need the
          extra context (already inside a node card). */}
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
            label: intl.formatMessage({ id: 'pages.compute.cards.col.mode' }),
            children: card.mode || '—',
          },
          {
            label: 'NUMA',
            children: card.numa,
          },
        ]}
      />
      <CardBody card={card} />
    </Drawer>
  );
};

export default CardDetailDrawer;
