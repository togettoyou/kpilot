import { useIntl } from '@umijs/max';
import { Col, Progress, Row, Table, Typography } from 'antd';
import React from 'react';

import type { GPUCardSummary } from '@/services/kpilot/gpu';

import { formatMB } from './format';

interface Props {
  card: GPUCardSummary;
  // Progress bar size — outer-drawer view wants the chunkier default,
  // inner-drawer (per-card list inside Node detail) prefers small to
  // fit more cards on screen.
  size?: 'default' | 'small';
}

// CardBody is the shared "what's inside a physical GPU card" rendering:
// three utilization progress bars (slot / memory / cores) followed by
// the list of pods landing on this card with their actual scheduler-
// allocated split. Both NodeDetailDrawer (renders many cards inline)
// and CardDetailDrawer (renders one in its own drawer) wrap this with
// their own framing.
const CardBody: React.FC<Props> = ({ card, size = 'default' }) => {
  const intl = useIntl();
  const memPct = card.devmem > 0 ? Math.round((card.usedMem / card.devmem) * 100) : 0;
  const corePct = card.devcore > 0 ? Math.round((card.usedCores / card.devcore) * 100) : 0;
  const slotPct = card.slots > 0 ? Math.round((card.usedSlots / card.slots) * 100) : 0;
  const pods = card.pods ?? [];

  return (
    <>
      <Row gutter={16} style={{ marginBottom: size === 'small' ? 8 : 16 }}>
        <Col xs={24} md={8}>
          <Typography.Text type="secondary">
            {intl.formatMessage({ id: 'pages.gpu.card.slots' })}
          </Typography.Text>
          <Progress
            percent={slotPct}
            size={size}
            format={() => `${card.usedSlots} / ${card.slots}`}
          />
        </Col>
        <Col xs={24} md={8}>
          <Typography.Text type="secondary">
            {intl.formatMessage({ id: 'pages.gpu.card.memory' })}
          </Typography.Text>
          <Progress
            percent={memPct}
            size={size}
            format={() => `${formatMB(card.usedMem)} / ${formatMB(card.devmem)}`}
          />
        </Col>
        <Col xs={24} md={8}>
          <Typography.Text type="secondary">
            {intl.formatMessage({ id: 'pages.gpu.card.cores' })}
          </Typography.Text>
          <Progress
            percent={corePct}
            size={size}
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
    </>
  );
};

export default CardBody;
