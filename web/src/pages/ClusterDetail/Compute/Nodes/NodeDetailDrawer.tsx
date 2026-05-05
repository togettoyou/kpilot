import { useIntl } from '@umijs/max';
import { Card, Col, Drawer, Progress, Row, Space, Table, Tag, Tooltip, Typography } from 'antd';
import React from 'react';

import type { GPUCardSummary, GPUNodeSummary } from '@/services/kpilot/gpu';

import { formatMB, RES_GPU, RES_GPUMEM } from '../format';

interface Props {
  node: GPUNodeSummary | null;
  open: boolean;
  onClose: () => void;
}

// NodeDetailDrawer is the full per-node view that the original combined
// page rendered inline. Pulled into a drawer so the Nodes table can stay
// terse and the detail still has space to show every card + pod.
const NodeDetailDrawer: React.FC<Props> = ({ node, open, onClose }) => {
  const intl = useIntl();
  if (!node) return null;

  const slotsTotal =
    node.allocatable?.[RES_GPU] ?? node.capacity?.[RES_GPU] ?? 0;
  const slotsUsed = node.used?.[RES_GPU] ?? 0;
  const memTotal =
    node.allocatable?.[RES_GPUMEM] ?? node.capacity?.[RES_GPUMEM] ?? 0;
  const memUsed = node.used?.[RES_GPUMEM] ?? 0;
  const cards = node.cards ?? [];
  const pods = node.pods ?? [];
  const hasCardDetail = cards.length > 0;

  return (
    <Drawer
      title={
        <Space>
          <span style={{ fontWeight: 600 }}>{node.name}</span>
          <Tag>{node.status}</Tag>
        </Space>
      }
      open={open}
      onClose={onClose}
      maskClosable={false}
      size="large"
    >
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={24} md={12}>
          <Typography.Text type="secondary">
            {intl.formatMessage({ id: 'pages.gpu.node.slots' })}
          </Typography.Text>
          <Progress
            percent={slotsTotal > 0 ? Math.round((slotsUsed / slotsTotal) * 100) : 0}
            format={() => `${slotsUsed} / ${slotsTotal}`}
            status={slotsUsed >= slotsTotal && slotsTotal > 0 ? 'exception' : 'active'}
          />
        </Col>
        {memTotal > 0 && (
          <Col xs={24} md={12}>
            <Typography.Text type="secondary">
              {intl.formatMessage({ id: 'pages.gpu.node.memory' })}
            </Typography.Text>
            <Progress
              percent={Math.round((memUsed / memTotal) * 100)}
              format={() => `${formatMB(memUsed)} / ${formatMB(memTotal)}`}
            />
          </Col>
        )}
      </Row>
      {hasCardDetail ? (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {cards.map((c) => (
            <CardDetail key={c.uuid} card={c} />
          ))}
        </Space>
      ) : (
        <Card title={intl.formatMessage({ id: 'pages.gpu.node.pods' })}>
          {pods.length === 0 ? (
            <Typography.Text type="secondary">
              {intl.formatMessage({ id: 'pages.gpu.node.pods.empty' })}
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
                  title: intl.formatMessage({ id: 'pages.gpu.node.pods.phase' }),
                  dataIndex: 'phase',
                  width: 100,
                  render: (v: string) => <Tag>{v}</Tag>,
                },
              ]}
            />
          )}
        </Card>
      )}
    </Drawer>
  );
};

const CardDetail: React.FC<{ card: GPUCardSummary }> = ({ card }) => {
  const intl = useIntl();
  const memPct = card.devmem > 0 ? Math.round((card.usedMem / card.devmem) * 100) : 0;
  const corePct = card.devcore > 0 ? Math.round((card.usedCores / card.devcore) * 100) : 0;
  const slotPct = card.slots > 0 ? Math.round((card.usedSlots / card.slots) * 100) : 0;
  const pods = card.pods ?? [];

  return (
    <Card
      type="inner"
      size="small"
      title={
        <Space>
          <span style={{ fontWeight: 500 }}>{card.type}</span>
          <Tooltip title={card.uuid}>
            <Typography.Text code style={{ fontSize: 11 }}>
              {card.uuid.length > 18 ? card.uuid.slice(0, 18) + '…' : card.uuid}
            </Typography.Text>
          </Tooltip>
          {card.health ? (
            <Tag color="success">
              {intl.formatMessage({ id: 'pages.gpu.node.devices.health.ok' })}
            </Tag>
          ) : (
            <Tag color="error">
              {intl.formatMessage({ id: 'pages.gpu.node.devices.health.bad' })}
            </Tag>
          )}
          {card.numa >= 0 && <Tag>NUMA {card.numa}</Tag>}
        </Space>
      }
    >
      <Row gutter={16} style={{ marginBottom: 8 }}>
        <Col xs={24} md={8}>
          <Typography.Text type="secondary">
            {intl.formatMessage({ id: 'pages.gpu.card.slots' })}
          </Typography.Text>
          <Progress percent={slotPct} size="small" format={() => `${card.usedSlots} / ${card.slots}`} />
        </Col>
        <Col xs={24} md={8}>
          <Typography.Text type="secondary">
            {intl.formatMessage({ id: 'pages.gpu.card.memory' })}
          </Typography.Text>
          <Progress
            percent={memPct}
            size="small"
            format={() => `${formatMB(card.usedMem)} / ${formatMB(card.devmem)}`}
          />
        </Col>
        <Col xs={24} md={8}>
          <Typography.Text type="secondary">
            {intl.formatMessage({ id: 'pages.gpu.card.cores' })}
          </Typography.Text>
          <Progress
            percent={corePct}
            size="small"
            format={() => `${card.usedCores}% / ${card.devcore}%`}
          />
        </Col>
      </Row>
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
    </Card>
  );
};

export default NodeDetailDrawer;
