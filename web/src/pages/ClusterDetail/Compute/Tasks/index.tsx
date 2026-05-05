import { ReloadOutlined } from '@ant-design/icons';
import { useIntl, useParams } from '@umijs/max';
import { Button, Card, Empty, Space, Table, Tag, Tooltip, Typography } from 'antd';
import React, { useMemo } from 'react';

import type { GPUNodeSummary } from '@/services/kpilot/gpu';

import DepGate from '../DepGate';
import { formatMB } from '../format';
import { useGPUData } from '../useGPUData';

// TaskRow flattens the cluster-wide GPU usage into a per-pod row,
// summing across cards if a pod spans multiple. Pod metadata
// (createdAt / appName / resourcePool / flavor / priority) is folded
// in from the node-level pod list since the per-card view doesn't
// carry those fields.
interface TaskRow {
  namespace: string;
  name: string;
  phase: string;
  node: string;
  cards: { uuid: string; type: string; mem: number; cores: number }[];
  totalMem: number;
  totalCores: number;
  cardCount: number;
  createdAt?: string;
  appName?: string;
  resourcePool?: string;
  flavor?: string;
  priority?: string;
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
    // Phase + metadata come from the node-level pods list (per-card
    // view doesn't carry them). Match by namespace+name; pods that
    // aren't in cards (vanilla NVIDIA plugin) won't have card data but
    // still get a row here from the fallback below.
    for (const p of n.pods ?? []) {
      const k = `${p.namespace}/${p.name}/${n.name}`;
      const meta = {
        phase: p.phase,
        createdAt: p.createdAt,
        appName: p.appName,
        resourcePool: p.resourcePool,
        flavor: p.flavor,
        priority: p.priority,
      };
      const row = acc.get(k);
      if (row) {
        Object.assign(row, meta);
      } else {
        // Fallback: pod has no per-card detail (vanilla NVIDIA device
        // plugin). Surface it with whatever request-level info we have.
        acc.set(k, {
          namespace: p.namespace,
          name: p.name,
          node: n.name,
          cards: [],
          totalMem: 0,
          totalCores: 0,
          cardCount: 0,
          ...meta,
        });
      }
    }
  }
  const out = Array.from(acc.values());
  out.sort((a, b) => b.totalMem - a.totalMem);
  return out;
}

// formatAge renders a duration since the given RFC3339 timestamp into a
// short kubectl-style label (5m, 2h, 3d). Returns a dash for empty /
// invalid input — the column then just shows "—" rather than "Invalid".
function formatAge(rfc3339: string | undefined): string {
  if (!rfc3339) return '—';
  const t = Date.parse(rfc3339);
  if (Number.isNaN(t)) return '—';
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86_400)}d`;
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
            {/* Built-in client-side pagination + sort + filter on
                ProTable's underlying Table — total GPU pod count is
                bounded enough (hundreds typical, low thousands extreme)
                that server-side scaling isn't justified yet. */}
            <Table<TaskRow>
              size="middle"
              rowKey={(r) => `${r.namespace}/${r.name}/${r.node}`}
              pagination={{ pageSize: 20, showSizeChanger: true }}
              dataSource={rows}
              scroll={{ x: 'max-content' }}
              columns={[
                {
                  title: intl.formatMessage({ id: 'pages.gpu.node.pods.namespace' }),
                  dataIndex: 'namespace',
                  sorter: (a, b) => a.namespace.localeCompare(b.namespace),
                  filterSearch: true,
                  // Build filters dynamically from the data so users
                  // see only namespaces that actually have GPU pods.
                  filters: Array.from(new Set(rows.map((r) => r.namespace))).map((ns) => ({
                    text: ns,
                    value: ns,
                  })),
                  onFilter: (v, r) => r.namespace === v,
                },
                {
                  title: intl.formatMessage({ id: 'pages.gpu.node.pods.name' }),
                  dataIndex: 'name',
                  sorter: (a, b) => a.name.localeCompare(b.name),
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.tasks.col.app' }),
                  dataIndex: 'appName',
                  width: 140,
                  render: (v: string | undefined) =>
                    v ? <Typography.Text>{v}</Typography.Text> : '—',
                },
                {
                  title: intl.formatMessage({ id: 'pages.gpu.node.pods.phase' }),
                  dataIndex: 'phase',
                  width: 100,
                  filters: [
                    { text: 'Running', value: 'Running' },
                    { text: 'Pending', value: 'Pending' },
                    { text: 'Unknown', value: 'Unknown' },
                  ],
                  onFilter: (v, r) => r.phase === v,
                  render: (v: string) => (v ? <Tag>{v}</Tag> : '—'),
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.tasks.col.node' }),
                  dataIndex: 'node',
                  filters: Array.from(new Set(rows.map((r) => r.node))).map((n) => ({
                    text: n,
                    value: n,
                  })),
                  onFilter: (v, r) => r.node === v,
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
                {
                  title: intl.formatMessage({ id: 'pages.compute.tasks.col.pool' }),
                  dataIndex: 'resourcePool',
                  width: 110,
                  render: (v: string | undefined) =>
                    v ? <Tag color="cyan">{v}</Tag> : '—',
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.tasks.col.flavor' }),
                  dataIndex: 'flavor',
                  width: 110,
                  render: (v: string | undefined) =>
                    v ? <Tag color="geekblue">{v}</Tag> : '—',
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.tasks.col.priority' }),
                  dataIndex: 'priority',
                  width: 90,
                  align: 'center',
                  render: (v: string | undefined) => v ?? '—',
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.tasks.col.age' }),
                  dataIndex: 'createdAt',
                  width: 80,
                  align: 'right',
                  sorter: (a, b) => {
                    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
                    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
                    return ta - tb;
                  },
                  render: (v: string | undefined) => (
                    <Tooltip title={v ?? ''}>{formatAge(v)}</Tooltip>
                  ),
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
