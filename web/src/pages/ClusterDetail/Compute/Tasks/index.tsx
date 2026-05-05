import { ReloadOutlined } from '@ant-design/icons';
import { useIntl, useParams } from '@umijs/max';
import { Button, Card, Empty, Space, Table, Tag, Tooltip, Typography } from 'antd';
import React, { useMemo } from 'react';

import type { GPUNodeSummary } from '@/services/kpilot/gpu';

import DepGate from '../DepGate';
import { formatMB } from '../format';
import { useGPUData } from '../useGPUData';

// TaskRow flattens the cluster-wide GPU usage into a per-pod row,
// summing across cards if a pod spans multiple. The cards array keeps
// the per-card breakdown so we can show a tooltip with each UUID.
interface TaskRow {
  namespace: string;
  name: string;
  phase: string;
  node: string;
  cards: { uuid: string; type: string; mem: number; cores: number }[];
  totalMem: number;
  totalCores: number;
  cardCount: number;
}

function buildRows(nodes: GPUNodeSummary[]): TaskRow[] {
  // Group by (namespace, name, node) — a single pod always lives on one
  // node, so node ID disambiguates pods that share names across namespaces.
  // The card set is the union of every (UUID, alloc) the pod owns on that
  // node from the per-card view.
  type Key = string;
  const acc = new Map<Key, TaskRow>();
  for (const n of nodes) {
    for (const c of n.cards ?? []) {
      for (const p of c.pods ?? []) {
        const k = `${p.namespace}/${p.name}/${n.name}`;
        let row = acc.get(k);
        if (!row) {
          row = {
            namespace: p.namespace,
            name: p.name,
            phase: '',
            node: n.name,
            cards: [],
            totalMem: 0,
            totalCores: 0,
            cardCount: 0,
          };
          acc.set(k, row);
        }
        row.cards.push({ uuid: c.uuid, type: c.type, mem: p.mem, cores: p.cores });
        row.totalMem += p.mem;
        row.totalCores += p.cores;
        row.cardCount++;
      }
    }
    // Phase comes from the node-level pods list (per-card view doesn't
    // carry it). Match by namespace+name; pods that aren't in cards
    // (vanilla NVIDIA plugin) won't have card data but still get a row
    // here from the fallback below.
    for (const p of n.pods ?? []) {
      const k = `${p.namespace}/${p.name}/${n.name}`;
      const row = acc.get(k);
      if (row) {
        row.phase = p.phase;
      } else {
        // Fallback: pod has no per-card detail (vanilla NVIDIA device
        // plugin). Surface it with whatever request-level info we have.
        acc.set(k, {
          namespace: p.namespace,
          name: p.name,
          phase: p.phase,
          node: n.name,
          cards: [],
          totalMem: 0,
          totalCores: 0,
          cardCount: 0,
        });
      }
    }
  }
  const out = Array.from(acc.values());
  out.sort((a, b) => b.totalMem - a.totalMem);
  return out;
}

const ComputeTasks: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const data = useGPUData(clusterId);
  const rows = useMemo(() => buildRows(data.nodes), [data.nodes]);

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
            {intl.formatMessage({ id: 'pages.compute.tasks.title' })}
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
            <Empty description={intl.formatMessage({ id: 'pages.compute.tasks.empty' })} />
          </Card>
        ) : (
          <Card>
            <Table<TaskRow>
              size="middle"
              rowKey={(r) => `${r.namespace}/${r.name}/${r.node}`}
              pagination={false}
              dataSource={rows}
              scroll={{ x: 'max-content' }}
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
                  render: (v: string) => (v ? <Tag>{v}</Tag> : '—'),
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.tasks.col.node' }),
                  dataIndex: 'node',
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.tasks.col.cards' }),
                  key: 'cards',
                  render: (_, r) =>
                    r.cards.length === 0 ? (
                      '—'
                    ) : (
                      <Space wrap>
                        {r.cards.map((c) => (
                          <Tooltip key={c.uuid} title={c.uuid}>
                            <Tag color="blue">
                              {c.type} ({formatMB(c.mem)} / {c.cores}%)
                            </Tag>
                          </Tooltip>
                        ))}
                      </Space>
                    ),
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.tasks.col.totalMem' }),
                  dataIndex: 'totalMem',
                  width: 130,
                  align: 'right',
                  sorter: (a, b) => a.totalMem - b.totalMem,
                  render: (v: number) => formatMB(v),
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.tasks.col.totalCores' }),
                  dataIndex: 'totalCores',
                  width: 110,
                  align: 'right',
                  sorter: (a, b) => a.totalCores - b.totalCores,
                  render: (v: number) => `${v}%`,
                },
              ]}
            />
          </Card>
        )}
      </div>
    </DepGate>
  );
};

export default ComputeTasks;
