import { ReloadOutlined } from '@ant-design/icons';
import { useIntl, useParams } from '@umijs/max';
import { Button, Card, Empty, Progress, Tag, Tooltip, Typography, Table } from 'antd';
import React, { useMemo, useState } from 'react';

import type { GPUCardSummary, GPUNodeSummary } from '@/services/kpilot/gpu';

import DepGate from '../DepGate';
import { formatMB } from '../format';
import { useGPUData } from '../useGPUData';
import CardDetailDrawer from './CardDetailDrawer';

// CardRow flattens nodes → cards into a single sortable list. The node
// name is preserved as a column so the user can pivot on it.
interface CardRow {
  uuid: string;
  type: string;
  mode?: string;
  health: boolean;
  numa: number;
  nodeName: string;
  slots: number;
  usedSlots: number;
  devmem: number;
  usedMem: number;
  devcore: number;
  usedCores: number;
  raw: GPUCardSummary;
}

function flatten(nodes: GPUNodeSummary[]): CardRow[] {
  const out: CardRow[] = [];
  for (const n of nodes) {
    for (const c of n.cards ?? []) {
      out.push({
        uuid: c.uuid,
        type: c.type,
        mode: c.mode,
        health: c.health,
        numa: c.numa,
        nodeName: n.name,
        slots: c.slots,
        usedSlots: c.usedSlots,
        devmem: c.devmem,
        usedMem: c.usedMem,
        devcore: c.devcore,
        usedCores: c.usedCores,
        raw: c,
      });
    }
  }
  return out;
}

const ComputeCards: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const data = useGPUData(clusterId);
  const rows = useMemo(() => flatten(data.nodes), [data.nodes]);
  const [active, setActive] = useState<{ card: GPUCardSummary; node: string } | null>(null);

  return (
    <DepGate
      hamiState={data.hamiState}
      loading={data.pluginsLoading}
      onRefresh={data.refreshPlugins}
    >
      <div style={{ padding: 24 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 16,
          }}
        >
          <Typography.Title level={4} style={{ margin: 0 }}>
            {intl.formatMessage({ id: 'pages.compute.cards.title' })}
          </Typography.Title>
          <Button
            icon={<ReloadOutlined spin={data.gpuLoading} />}
            onClick={data.refreshGPU}
          >
            {intl.formatMessage({ id: 'pages.gpu.cta.refresh' })}
          </Button>
        </div>
        {rows.length === 0 ? (
          <Card>
            <Empty description={intl.formatMessage({ id: 'pages.compute.cards.empty' })} />
          </Card>
        ) : (
          <Card>
            <Table<CardRow>
              size="middle"
              rowKey="uuid"
              pagination={false}
              dataSource={rows}
              scroll={{ x: 'max-content' }}
              columns={[
                {
                  title: intl.formatMessage({ id: 'pages.compute.cards.col.uuid' }),
                  dataIndex: 'uuid',
                  render: (v: string) => (
                    <Tooltip title={v}>
                      <Typography.Text code style={{ fontSize: 12 }}>
                        {v.length > 22 ? v.slice(0, 22) + '…' : v}
                      </Typography.Text>
                    </Tooltip>
                  ),
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.cards.col.type' }),
                  dataIndex: 'type',
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.cards.col.mode' }),
                  dataIndex: 'mode',
                  width: 110,
                  render: (v: string | undefined) =>
                    v ? <Tag>{v}</Tag> : '—',
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.cards.col.node' }),
                  dataIndex: 'nodeName',
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.cards.col.health' }),
                  dataIndex: 'health',
                  width: 80,
                  render: (v: boolean) =>
                    v ? (
                      <Tag color="success">
                        {intl.formatMessage({ id: 'pages.gpu.node.devices.health.ok' })}
                      </Tag>
                    ) : (
                      <Tag color="error">
                        {intl.formatMessage({ id: 'pages.gpu.node.devices.health.bad' })}
                      </Tag>
                    ),
                },
                {
                  title: 'NUMA',
                  dataIndex: 'numa',
                  width: 70,
                  align: 'right',
                },
                {
                  title: intl.formatMessage({ id: 'pages.gpu.card.slots' }),
                  key: 'slots',
                  width: 200,
                  render: (_, r) =>
                    r.slots > 0 ? (
                      <Progress
                        percent={Math.round((r.usedSlots / r.slots) * 100)}
                        size="small"
                        format={() => `${r.usedSlots} / ${r.slots}`}
                      />
                    ) : '—',
                },
                {
                  title: intl.formatMessage({ id: 'pages.gpu.card.memory' }),
                  key: 'memory',
                  width: 240,
                  render: (_, r) =>
                    r.devmem > 0 ? (
                      <Progress
                        percent={Math.round((r.usedMem / r.devmem) * 100)}
                        size="small"
                        format={() => `${formatMB(r.usedMem)} / ${formatMB(r.devmem)}`}
                      />
                    ) : '—',
                },
                {
                  title: intl.formatMessage({ id: 'pages.gpu.card.cores' }),
                  key: 'cores',
                  width: 200,
                  render: (_, r) =>
                    r.devcore > 0 ? (
                      <Progress
                        percent={Math.round((r.usedCores / r.devcore) * 100)}
                        size="small"
                        format={() => `${r.usedCores}% / ${r.devcore}%`}
                      />
                    ) : '—',
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.nodes.col.action' }),
                  key: 'action',
                  width: 80,
                  fixed: 'right',
                  render: (_, r) => (
                    <Button
                      type="link"
                      size="small"
                      onClick={() => setActive({ card: r.raw, node: r.nodeName })}
                    >
                      {intl.formatMessage({ id: 'pages.compute.nodes.detail' })}
                    </Button>
                  ),
                },
              ]}
            />
          </Card>
        )}
      </div>
      <CardDetailDrawer
        card={active?.card ?? null}
        nodeName={active?.node ?? ''}
        open={active !== null}
        onClose={() => setActive(null)}
      />
    </DepGate>
  );
};

export default ComputeCards;
