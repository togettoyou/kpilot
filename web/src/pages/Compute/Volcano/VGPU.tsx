import type { ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { useIntl, useParams, useRequest } from '@umijs/max';
import {
  Card as AntCard,
  Col,
  Progress,
  Row,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import React from 'react';

import {
  getVGPUSnapshot,
  type VGPUCard,
  type VGPUNode,
  type VGPUSnapshot,
} from '@/services/kpilot/vgpu';
import {
  isResourceNotAvailable,
  NotInstalled,
  RefreshControl,
  ResourceIntro,
  useAutoRefresh,
} from './shared/Layout';

const { Text } = Typography;

// /compute/:id/vgpu — projects every Node's vGPU register + every
// Pod's vgpu-ids-new annotation into:
//   1) a cluster KPI strip (cards / slots / memory)
//   2) a per-node table where each row expands to its per-card list
//      with the pods currently using each card.
//
// One server endpoint backs the whole page; we don't paginate or
// fetch on-demand because cluster-wide vGPU state is small enough
// (<10 MB JSON even for big clusters) that one call per refresh is
// fine — and lets sorting / filtering happen client-side.

export default function VGPUPage() {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();

  const { data, loading, error, refresh } = useRequest(
    () => getVGPUSnapshot(clusterId!),
    {
      formatResult: (res) => res,
      ready: !!clusterId,
      refreshDeps: [clusterId],
    },
  );

  const [interval, setInterval] = useAutoRefresh(refresh, !!clusterId);

  if (!clusterId) return null;
  // RESOURCE_NOT_AVAILABLE covers both "device-plugin not installed"
  // and "no nodes registered yet". The shared NotInstalled component
  // defaults to "Volcano not installed" copy (right for the 10 CR
  // pages), but here the missing piece is volcano-vgpu-device-plugin
  // specifically — override the title / subtitle so the button + copy
  // point users at the right plugin.
  if (error && isResourceNotAvailable(error)) {
    return (
      <NotInstalled
        clusterId={clusterId}
        titleId="pages.compute.vgpu.notInstalled.title"
        subTitleId="pages.compute.vgpu.notInstalled.subTitle"
        actionId="pages.compute.vgpu.notInstalled.action"
      />
    );
  }

  const snapshot = data;
  const nodes = snapshot?.nodes ?? [];

  return (
    <div className="p-6">
      <ResourceIntro id="pages.compute.intro.vgpu" />
      <ClusterKPIs snapshot={snapshot} loading={loading} />
      <NodeTable
        nodes={nodes}
        loading={loading}
        interval={interval}
        setInterval={setInterval}
        refresh={refresh}
      />
    </div>
  );
}

// ─── Cluster KPIs ─────────────────────────────────────────────────────

// formatGiB converts MiB → GiB with one decimal place. The wire format
// is MiB (matches `nvidia-smi --query-gpu=memory.total`); GiB is the
// natural display unit for cluster-scale totals.
function formatGiB(mib: number): string {
  if (!Number.isFinite(mib) || mib <= 0) return '0';
  return (mib / 1024).toFixed(1);
}

function pct(used: number, total: number): number {
  if (!total) return 0;
  const v = Math.round((used / total) * 100);
  return Math.max(0, Math.min(100, v));
}

function ClusterKPIs({
  snapshot,
  loading,
}: {
  snapshot: VGPUSnapshot | undefined;
  loading: boolean;
}) {
  const intl = useIntl();
  const totalCards = snapshot?.totalCards ?? 0;
  const totalSlots = snapshot?.totalSlots ?? 0;
  const usedSlots = snapshot?.usedSlots ?? 0;
  const totalMemory = snapshot?.totalMemory ?? 0;
  const usedMemory = snapshot?.usedMemory ?? 0;
  const slotPct = pct(usedSlots, totalSlots);
  const memPct = pct(usedMemory, totalMemory);
  return (
    <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
      <Col xs={24} sm={12} md={6}>
        <AntCard size="small" loading={loading}>
          <Statistic
            title={intl.formatMessage({ id: 'pages.compute.vgpu.kpi.cards' })}
            value={totalCards}
          />
        </AntCard>
      </Col>
      <Col xs={24} sm={12} md={6}>
        <AntCard size="small" loading={loading}>
          <Statistic
            title={intl.formatMessage({ id: 'pages.compute.vgpu.kpi.slots' })}
            value={`${usedSlots} / ${totalSlots}`}
          />
          <Progress
            percent={slotPct}
            size="small"
            status={slotPct >= 90 ? 'exception' : 'normal'}
            showInfo={false}
            style={{ marginTop: 4 }}
          />
        </AntCard>
      </Col>
      <Col xs={24} sm={12} md={6}>
        <AntCard size="small" loading={loading}>
          <Statistic
            title={intl.formatMessage({ id: 'pages.compute.vgpu.kpi.memory' })}
            value={`${formatGiB(usedMemory)} / ${formatGiB(totalMemory)} GiB`}
          />
          <Progress
            percent={memPct}
            size="small"
            status={memPct >= 90 ? 'exception' : 'normal'}
            showInfo={false}
            style={{ marginTop: 4 }}
          />
        </AntCard>
      </Col>
      <Col xs={24} sm={12} md={6}>
        <AntCard size="small" loading={loading}>
          <Statistic
            title={intl.formatMessage({ id: 'pages.compute.vgpu.kpi.nodes' })}
            value={snapshot?.nodes.length ?? 0}
          />
        </AntCard>
      </Col>
    </Row>
  );
}

// ─── Per-node table with expandable per-card detail ──────────────────

function NodeTable({
  nodes,
  loading,
  interval,
  setInterval,
  refresh,
}: {
  nodes: VGPUNode[];
  loading: boolean;
  interval: number;
  setInterval: (n: number) => void;
  refresh: () => void;
}) {
  const intl = useIntl();
  const columns: ProColumns<VGPUNode>[] = [
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.node.col.name' }),
      dataIndex: 'name',
      width: 220,
      fixed: 'left',
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.node.col.health' }),
      dataIndex: 'healthy',
      width: 90,
      render: (_, r) =>
        r.healthy ? (
          <Tag color="green">healthy</Tag>
        ) : (
          <Tag color="red">degraded</Tag>
        ),
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.node.col.cards' }),
      key: 'cards',
      width: 90,
      render: (_, r) => r.cards.length,
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.node.col.slots' }),
      key: 'slots',
      width: 200,
      render: (_, r) => (
        <UtilBar used={r.usedNumber} total={r.totalNumber} unit="" />
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.node.col.memory' }),
      key: 'memory',
      width: 240,
      render: (_, r) => (
        <UtilBar used={r.usedMemory} total={r.totalMemory} unit="MiB" />
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.node.col.types' }),
      key: 'types',
      width: 280,
      render: (_, r) => {
        const counts = new Map<string, number>();
        for (const c of r.cards) {
          counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
        }
        if (counts.size === 0)
          return <Text type="secondary">-</Text>;
        return (
          <Space size={4} wrap>
            {[...counts.entries()].map(([type, n]) => (
              <Tag key={type} color="blue" style={{ marginInlineEnd: 0 }}>
                {type} × {n}
              </Tag>
            ))}
          </Space>
        );
      },
    },
  ];
  return (
    <ProTable<VGPUNode>
      rowKey="name"
      columns={columns}
      dataSource={nodes}
      loading={loading}
      search={false}
      pagination={{ pageSize: 20, showSizeChanger: true }}
      scroll={{ x: 'max-content' }}
      options={{ reload: false }}
      // Each node row expands into its per-card detail table — we
      // tried showing all cards as a flat top-level list and found
      // it lost the "which node is hot" signal that operators care
      // about most. Click to drill in.
      expandable={{
        expandedRowRender: (record) => <CardTable cards={record.cards} />,
        rowExpandable: (record) => record.cards.length > 0,
      }}
      headerTitle={
        <Space>
          <Text strong>
            {intl.formatMessage({ id: 'pages.compute.vgpu.node.title' })}
          </Text>
          <Text type="secondary">({nodes.length})</Text>
        </Space>
      }
      toolBarRender={() => [
        <RefreshControl
          key="refresh"
          interval={interval}
          setInterval={setInterval}
          refresh={refresh}
          loading={loading}
        />,
      ]}
    />
  );
}

// ─── Per-card nested table ───────────────────────────────────────────

function CardTable({ cards }: { cards: VGPUCard[] }) {
  const intl = useIntl();
  const columns: ProColumns<VGPUCard>[] = [
    {
      title: '#',
      dataIndex: 'index',
      width: 60,
    },
    {
      title: 'UUID',
      dataIndex: 'uuid',
      width: 220,
      render: (_, r) => (
        <Text style={{ fontSize: 12 }} code copyable={{ text: r.uuid }}>
          {r.uuid.length > 12 ? `${r.uuid.slice(0, 12)}…` : r.uuid}
        </Text>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.card.col.type' }),
      dataIndex: 'type',
      width: 200,
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.card.col.health' }),
      dataIndex: 'health',
      width: 80,
      render: (_, r) =>
        r.health ? (
          <Tag color="green">OK</Tag>
        ) : (
          <Tag color="red">bad</Tag>
        ),
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.card.col.sharing' }),
      dataIndex: 'sharingMode',
      width: 100,
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.card.col.slots' }),
      key: 'slots',
      width: 200,
      render: (_, r) => (
        <UtilBar used={r.usedNumber} total={r.number} unit="" />
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.card.col.memory' }),
      key: 'memory',
      width: 240,
      render: (_, r) => (
        <UtilBar used={r.usedMemory} total={r.memory} unit="MiB" />
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.card.col.cores' }),
      key: 'cores',
      width: 110,
      render: (_, r) => (r.usedCores > 0 ? `${r.usedCores}%` : '-'),
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.card.col.pods' }),
      key: 'pods',
      width: 260,
      render: (_, r) => <PodsCell pods={r.pods ?? []} />,
    },
  ];
  return (
    <ProTable<VGPUCard>
      rowKey="uuid"
      columns={columns}
      dataSource={cards}
      search={false}
      pagination={false}
      options={false}
      scroll={{ x: 'max-content' }}
      size="small"
      // No header — this is rendered inline inside an expanded row.
      headerTitle={false}
      toolBarRender={false}
    />
  );
}

function PodsCell({
  pods,
}: {
  pods: { namespace: string; name: string; usedMemory: number; usedCores: number }[];
}) {
  const intl = useIntl();
  if (pods.length === 0)
    return <Text type="secondary">{intl.formatMessage({ id: 'pages.compute.vgpu.card.pods.idle' })}</Text>;
  // Each pod may show up multiple times if it allocated multiple
  // slices on this card. Collapse to "namespace/name × N" so the
  // cell stays readable.
  const counts = new Map<string, { count: number; mem: number; cores: number }>();
  for (const p of pods) {
    const key = `${p.namespace}/${p.name}`;
    const prev = counts.get(key) ?? { count: 0, mem: 0, cores: 0 };
    counts.set(key, {
      count: prev.count + 1,
      mem: prev.mem + p.usedMemory,
      cores: prev.cores + p.usedCores,
    });
  }
  return (
    <Space direction="vertical" size={2} style={{ lineHeight: 1.4 }}>
      {[...counts.entries()].map(([key, agg]) => (
        <Tooltip
          key={key}
          title={`${agg.mem} MiB · ${agg.cores}% cores${
            agg.count > 1 ? ` · ${agg.count} slices` : ''
          }`}
        >
          <Text style={{ fontSize: 12 }} ellipsis>
            {key}
            {agg.count > 1 ? ` × ${agg.count}` : ''}
          </Text>
        </Tooltip>
      ))}
    </Space>
  );
}

// ─── Shared bar ──────────────────────────────────────────────────────

// UtilBar shows used / total with a thin progress bar underneath.
// Compact (2 lines max), works for both slot counts (unitless) and
// memory (MiB).
function UtilBar({
  used,
  total,
  unit,
}: {
  used: number;
  total: number;
  unit: string;
}) {
  const p = pct(used, total);
  return (
    <Space direction="vertical" size={0} style={{ width: '100%' }}>
      <Text style={{ fontSize: 12 }}>
        {used} / {total}
        {unit ? ` ${unit}` : ''} · {p}%
      </Text>
      <Progress
        percent={p}
        size="small"
        status={p >= 90 ? 'exception' : 'normal'}
        showInfo={false}
      />
    </Space>
  );
}
