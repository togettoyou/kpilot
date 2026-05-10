import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Bar, Pie } from '@ant-design/plots';
import { useIntl, useParams } from '@umijs/max';
import {
  Button,
  Card,
  Col,
  Empty,
  Progress,
  Row,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useThemeMode } from 'antd-style';
import React, { useMemo, useState } from 'react';

import type {
  GPUCardSummary,
  GPUNodeSummary,
} from '@/services/kpilot/gpu';

import CardBody from '../CardBody';
import DepGate from '../DepGate';
import { formatMB, RES_GPU, RES_GPUMEM, RES_GPUCORES } from '../format';
import { useGPUData } from '../useGPUData';
import CardDetailDrawer from './CardDetailDrawer';
import NodeDetailDrawer from './NodeDetailDrawer';

// ─── Cluster-level KPI rollup ─────────────────────────────────────────────

interface ClusterKPIs {
  nodes: number;
  cards: number;
  vGpuTotal: number;
  vGpuUsed: number;
  vGpuMemTotalMB: number;
  vGpuMemUsedMB: number;
  vGpuCoresTotal: number;
  vGpuCoresUsed: number;
  modelDist: { type: string; count: number }[];
}

function rollupKPIs(nodes: GPUNodeSummary[]): ClusterKPIs {
  const k: ClusterKPIs = {
    nodes: nodes.length,
    cards: 0,
    vGpuTotal: 0,
    vGpuUsed: 0,
    vGpuMemTotalMB: 0,
    vGpuMemUsedMB: 0,
    vGpuCoresTotal: 0,
    vGpuCoresUsed: 0,
    modelDist: [],
  };
  const modelMap = new Map<string, number>();
  for (const n of nodes) {
    k.cards += n.devices?.length ?? 0;
    // Prefer per-card sums over the node-level capacity/used maps.
    // Reasons:
    //   - HAMi advertises `nvidia.com/gpu` as physical card count
    //     (not slot count), so summing slots from cards gives the
    //     real vGPU capacity (e.g. 2 cards × 10 slots = 20).
    //   - kwok mock and some HAMi configs don't populate gpumem /
    //     gpucores at all in node-level capacity, so node-level
    //     reads return 0 and the KPI looks broken.
    //   - Per-card detail is the source of truth from HAMi's
    //     hami.io/node-nvidia-register annotation; node resources
    //     only mirror a subset.
    // Fallback to node-level only when the node has no card detail
    // (vanilla NVIDIA device plugin, no HAMi registration).
    if (n.cards && n.cards.length > 0) {
      for (const c of n.cards) {
        k.vGpuTotal += c.slots;
        k.vGpuUsed += c.usedSlots;
        k.vGpuMemTotalMB += c.devmem;
        k.vGpuMemUsedMB += c.usedMem;
        k.vGpuCoresTotal += c.devcore;
        k.vGpuCoresUsed += c.usedCores;
      }
    } else {
      k.vGpuTotal += n.allocatable?.[RES_GPU] ?? n.capacity?.[RES_GPU] ?? 0;
      k.vGpuUsed += n.used?.[RES_GPU] ?? 0;
      k.vGpuMemTotalMB +=
        n.allocatable?.[RES_GPUMEM] ?? n.capacity?.[RES_GPUMEM] ?? 0;
      k.vGpuMemUsedMB += n.used?.[RES_GPUMEM] ?? 0;
      k.vGpuCoresTotal +=
        n.allocatable?.[RES_GPUCORES] ?? n.capacity?.[RES_GPUCORES] ?? 0;
      k.vGpuCoresUsed += n.used?.[RES_GPUCORES] ?? 0;
    }
    for (const d of n.devices ?? []) {
      modelMap.set(d.type, (modelMap.get(d.type) ?? 0) + 1);
    }
  }
  k.modelDist = Array.from(modelMap.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
  return k;
}

// ─── Top-level dashboard ──────────────────────────────────────────────────

const ComputeOverview: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const data = useGPUData(clusterId);
  const kpis = useMemo(() => rollupKPIs(data.nodes), [data.nodes]);

  const [activeNode, setActiveNode] = useState<GPUNodeSummary | null>(null);
  const [activeCard, setActiveCard] = useState<{
    card: GPUCardSummary;
    node: string;
  } | null>(null);

  return (
    <DepGate
      depState={data.depState}
      loading={data.pluginsLoading}
      onRefresh={data.refreshPlugins}
    >
      <div style={{ padding: 24 }}>
        <Header
          title={intl.formatMessage({ id: 'pages.compute.overview.title' })}
          nodes={kpis.nodes}
          cards={kpis.cards}
          loading={data.gpuLoading}
          onRefresh={data.refreshGPU}
        />

        <KPIStrip kpis={kpis} />

        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col xs={24} lg={12}>
            <ModelDistribution dist={kpis.modelDist} totalCards={kpis.cards} />
          </Col>
          <Col xs={24} lg={12}>
            <TopConsumers nodes={data.nodes} />
          </Col>
        </Row>

        <NodeGrid
          nodes={data.nodes}
          onDetail={(n) => setActiveNode(n)}
        />

        <DetailTabs
          nodes={data.nodes}
          onCardDetail={(card, node) => setActiveCard({ card, node })}
        />

        {kpis.nodes === 0 && (
          <Card style={{ marginTop: 16 }}>
            <Empty
              description={intl.formatMessage({ id: 'pages.gpu.empty' })}
            />
          </Card>
        )}
      </div>

      <NodeDetailDrawer
        node={activeNode}
        open={activeNode !== null}
        onClose={() => setActiveNode(null)}
      />
      <CardDetailDrawer
        card={activeCard?.card ?? null}
        nodeName={activeCard?.node ?? ''}
        open={activeCard !== null}
        onClose={() => setActiveCard(null)}
      />
    </DepGate>
  );
};

// Header carries the page title plus a fleet-size subtitle ("X 节点 ·
// Y 物理卡"). The counts used to be standalone count cards in the KPI
// strip, but they're context — not measurements — so they fit better
// as page meta. Frees the KPI strip up to be three equal-width gauges.
const Header: React.FC<{
  title: string;
  nodes: number;
  cards: number;
  loading: boolean;
  onRefresh: () => void;
}> = ({ title, nodes, cards, loading, onRefresh }) => {
  const intl = useIntl();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 16,
      }}
    >
      <Space size={12} align="baseline">
        <Typography.Title level={4} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          <ThunderboltOutlined style={{ color: '#1677ff', marginRight: 4 }} />
          {intl.formatMessage(
            { id: 'pages.compute.overview.fleet' },
            { nodes, cards },
          )}
        </Typography.Text>
      </Space>
      <Button icon={<ReloadOutlined spin={loading} />} onClick={onRefresh}>
        {intl.formatMessage({ id: 'pages.gpu.cta.refresh' })}
      </Button>
    </div>
  );
};

// ─── Section 1: KPI strip ─────────────────────────────────────────────────
//
// Three equal-width gauges — vGPU slots / memory / cores. Counts
// (nodes, cards) live in the page header subtitle now: they're context,
// not measurements, and squeezing them in here as separate count cards
// produced an awkward "small box + big box" mismatch in the same row.
const KPIStrip: React.FC<{ kpis: ClusterKPIs }> = ({ kpis }) => {
  const intl = useIntl();
  const slotPct =
    kpis.vGpuTotal > 0 ? kpis.vGpuUsed / kpis.vGpuTotal : 0;
  const memPct =
    kpis.vGpuMemTotalMB > 0 ? kpis.vGpuMemUsedMB / kpis.vGpuMemTotalMB : 0;
  const corePct =
    kpis.vGpuCoresTotal > 0 ? kpis.vGpuCoresUsed / kpis.vGpuCoresTotal : 0;
  return (
    <Row gutter={16} style={{ marginBottom: 16 }} align="stretch">
      <Col xs={24} md={8} style={{ display: 'flex' }}>
        <GaugeCard
          title={intl.formatMessage({ id: 'pages.gpu.kpi.vgpuUsage' })}
          ratio={slotPct}
          footer={`${kpis.vGpuUsed} / ${kpis.vGpuTotal}`}
        />
      </Col>
      <Col xs={24} md={8} style={{ display: 'flex' }}>
        <GaugeCard
          title={intl.formatMessage({ id: 'pages.gpu.kpi.memUsage' })}
          ratio={memPct}
          footer={`${formatMB(kpis.vGpuMemUsedMB)} / ${formatMB(kpis.vGpuMemTotalMB)}`}
        />
      </Col>
      <Col xs={24} md={8} style={{ display: 'flex' }}>
        <GaugeCard
          title={intl.formatMessage({ id: 'pages.gpu.kpi.coreUsage' })}
          ratio={corePct}
          footer={`${kpis.vGpuCoresUsed}% / ${kpis.vGpuCoresTotal}%`}
        />
      </Col>
    </Row>
  );
};

// GaugeCard uses antd's built-in Progress type="dashboard" — that's
// effectively a 3/4-arc gauge already. Tried @ant-design/plots Gauge
// first but it renders blank under autoFit; the upstream demos all
// set autoFit:false + explicit width/height. Progress dashboard
// gives the same gauge silhouette with zero layout fuss and one
// less chart-engine to keep happy. Color shifts amber/red past
// 70% / 90% so over-utilized resources jump out without reading
// the percent.
const GaugeCard: React.FC<{
  title: string;
  ratio: number;
  footer: string;
}> = ({ title, ratio, footer }) => {
  const { isDarkMode } = useThemeMode();
  const pct = Math.max(0, Math.min(1, ratio));
  const pctRound = Math.round(pct * 100);
  const stroke =
    pct >= 0.9 ? '#ff4d4f' : pct >= 0.7 ? '#faad14' : '#1677ff';
  return (
    <Card style={{ width: '100%' }}>
      <div
        style={{
          fontSize: 14,
          color: isDarkMode ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)',
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <Progress
          type="dashboard"
          percent={pctRound}
          strokeColor={stroke}
          size={120}
          format={(p) => `${p}%`}
        />
      </div>
      <div
        style={{
          fontSize: 12,
          color: isDarkMode ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)',
          textAlign: 'center',
          marginTop: 4,
        }}
      >
        {footer}
      </div>
    </Card>
  );
};

// ─── Section 2a: GPU model distribution ───────────────────────────────────
//
// Donut form factor (innerRadius 0.6) instead of full pie — the empty
// center reads less heavy and lets us put the total card count there
// later if needed. Legend on the right lists model + count so users
// can match colors back to types without hovering each slice.
const ModelDistribution: React.FC<{
  dist: { type: string; count: number }[];
  totalCards: number;
}> = ({ dist, totalCards }) => {
  const intl = useIntl();
  const { isDarkMode } = useThemeMode();
  return (
    <Card
      title={intl.formatMessage({ id: 'pages.compute.overview.modelDist' })}
      style={{ height: '100%' }}
    >
      {dist.length === 0 ? (
        <Typography.Text type="secondary">
          {intl.formatMessage({ id: 'pages.gpu.empty' })}
        </Typography.Text>
      ) : (
        <div style={{ height: 260 }}>
          <Pie
            autoFit
            theme={isDarkMode ? 'classicDark' : 'classic'}
            data={dist}
            angleField="count"
            colorField="type"
            radius={0.9}
            innerRadius={0.6}
            label={{
              position: 'spider',
              text: (d: { type: string; count: number }) =>
                `${d.type} ${Math.round((d.count / totalCards) * 100)}%`,
              style: { fontSize: 11 },
            }}
            legend={{
              color: {
                position: 'right',
                rowPadding: 4,
              },
            }}
            tooltip={(d: { type: string; count: number }) => ({
              name: d.type,
              value: `${d.count} (${Math.round((d.count / totalCards) * 100)}%)`,
            })}
          />
        </div>
      )}
    </Card>
  );
};

// ─── Section 2b: Top N consumers ──────────────────────────────────────────

interface ConsumerRow {
  namespace: string;
  name: string;
  node: string;
  cardType: string;
  mem: number;
}

const TopConsumers: React.FC<{ nodes: GPUNodeSummary[] }> = ({ nodes }) => {
  const intl = useIntl();
  const { isDarkMode } = useThemeMode();
  const rows = useMemo<ConsumerRow[]>(() => {
    const out: ConsumerRow[] = [];
    for (const n of nodes) {
      for (const c of n.cards ?? []) {
        for (const p of c.pods ?? []) {
          out.push({
            namespace: p.namespace,
            name: p.name,
            node: n.name,
            cardType: c.type,
            mem: p.mem,
          });
        }
      }
    }
    out.sort((a, b) => b.mem - a.mem);
    return out.slice(0, 5);
  }, [nodes]);

  // Bar chart wants {label, mem} — concat ns/name into label and clip
  // long names so the y-axis stays readable. Tooltip carries the full
  // identifier on hover.
  const data = useMemo(
    () =>
      rows.map((r) => {
        const ident = `${r.namespace}/${r.name}`;
        return {
          label: ident.length > 28 ? ident.slice(0, 28) + '…' : ident,
          memMB: r.mem,
          memHuman: formatMB(r.mem),
          cardType: r.cardType,
          fullIdent: ident,
        };
      }),
    [rows],
  );

  return (
    <Card
      title={intl.formatMessage({ id: 'pages.compute.overview.topConsumers' })}
      style={{ height: '100%' }}
    >
      {data.length === 0 ? (
        <Typography.Text type="secondary">
          {intl.formatMessage({ id: 'pages.compute.tasks.empty' })}
        </Typography.Text>
      ) : (
        <div style={{ height: 260 }}>
          {/* v2 horizontal Bar: xField is the numeric value (bar
              length), yField is the category (vertical position).
              I had them swapped — that produced a vertical column
              with no labels. */}
          <Bar
            autoFit
            theme={isDarkMode ? 'classicDark' : 'classic'}
            data={data}
            xField="memMB"
            yField="label"
            colorField="cardType"
            sort={{ reverse: true, by: 'x' }}
            axis={{
              x: {
                labelFormatter: (v: number) => formatMB(v),
                labelFontSize: 11,
              },
              y: { labelFontSize: 11 },
            }}
            tooltip={(d: { fullIdent: string; memHuman: string; cardType: string }) => ({
              name: d.fullIdent,
              value: `${d.memHuman} · ${d.cardType}`,
            })}
            legend={{
              color: { position: 'top', layout: { justifyContent: 'flex-start' } },
            }}
          />
        </div>
      )}
    </Card>
  );
};

// ─── Section 3: Node grid ─────────────────────────────────────────────────

const NodeGrid: React.FC<{
  nodes: GPUNodeSummary[];
  onDetail: (n: GPUNodeSummary) => void;
}> = ({ nodes, onDetail }) => {
  const intl = useIntl();
  if (nodes.length === 0) return null;
  return (
    <Card
      title={intl.formatMessage({ id: 'pages.compute.overview.nodeGrid' })}
      style={{ marginBottom: 16 }}
    >
      <Row gutter={[16, 16]}>
        {nodes.map((n) => (
          <Col key={n.name} xs={24} sm={12} md={8} xl={6}>
            <NodeTile node={n} onDetail={() => onDetail(n)} />
          </Col>
        ))}
      </Row>
    </Card>
  );
};

const NodeTile: React.FC<{
  node: GPUNodeSummary;
  onDetail: () => void;
}> = ({ node, onDetail }) => {
  const intl = useIntl();
  // Sum from cards when present (same reason as rollupKPIs above —
  // node-level resource maps don't always carry slot/mem/cores totals).
  let slotsTotal = 0;
  let slotsUsed = 0;
  let memTotal = 0;
  let memUsed = 0;
  let coresTotal = 0;
  let coresUsed = 0;
  if (node.cards && node.cards.length > 0) {
    for (const c of node.cards) {
      slotsTotal += c.slots;
      slotsUsed += c.usedSlots;
      memTotal += c.devmem;
      memUsed += c.usedMem;
      coresTotal += c.devcore;
      coresUsed += c.usedCores;
    }
  } else {
    slotsTotal = node.allocatable?.[RES_GPU] ?? node.capacity?.[RES_GPU] ?? 0;
    slotsUsed = node.used?.[RES_GPU] ?? 0;
    memTotal =
      node.allocatable?.[RES_GPUMEM] ?? node.capacity?.[RES_GPUMEM] ?? 0;
    memUsed = node.used?.[RES_GPUMEM] ?? 0;
    coresTotal =
      node.allocatable?.[RES_GPUCORES] ?? node.capacity?.[RES_GPUCORES] ?? 0;
    coresUsed = node.used?.[RES_GPUCORES] ?? 0;
  }
  const cardCount = node.devices?.length ?? 0;

  // Pick the dominant model and a "+N" suffix when the node is mixed.
  const modelCounts = new Map<string, number>();
  for (const d of node.devices ?? []) {
    modelCounts.set(d.type, (modelCounts.get(d.type) ?? 0) + 1);
  }
  let modelLabel = '';
  if (modelCounts.size === 1) {
    modelLabel = Array.from(modelCounts.keys())[0];
  } else if (modelCounts.size > 1) {
    const entries = Array.from(modelCounts.entries()).sort(
      (a, b) => b[1] - a[1],
    );
    modelLabel = `${entries[0][0]} +${modelCounts.size - 1}`;
  }

  return (
    <Card
      size="small"
      title={
        <Space size={6}>
          <NodeStatusBadge status={node.status} />
          <Typography.Text strong ellipsis style={{ maxWidth: 160 }}>
            {node.name}
          </Typography.Text>
        </Space>
      }
      extra={
        <Button type="link" size="small" onClick={onDetail}>
          {intl.formatMessage({ id: 'pages.compute.nodes.detail' })}
        </Button>
      }
    >
      <div style={{ marginBottom: 8, fontSize: 12 }}>
        <Space size={4} wrap>
          <Tag>
            {cardCount}{' '}
            {intl.formatMessage({ id: 'pages.compute.nodes.col.cards' })}
          </Tag>
          {modelLabel && (
            <Typography.Text code style={{ fontSize: 11 }}>
              {modelLabel}
            </Typography.Text>
          )}
        </Space>
      </div>
      <MiniBar
        label={intl.formatMessage({ id: 'pages.gpu.card.slots' })}
        used={slotsUsed}
        total={slotsTotal}
        kind="count"
      />
      <MiniBar
        label={intl.formatMessage({ id: 'pages.gpu.card.memory' })}
        used={memUsed}
        total={memTotal}
        kind="memory"
      />
      <MiniBar
        label={intl.formatMessage({ id: 'pages.gpu.card.cores' })}
        used={coresUsed}
        total={coresTotal}
        kind="percent"
      />
    </Card>
  );
};

const MiniBar: React.FC<{
  label: string;
  used: number;
  total: number;
  kind: 'count' | 'memory' | 'percent';
}> = ({ label, used, total, kind }) => {
  if (total === 0) {
    return (
      <div style={{ marginBottom: 4 }}>
        <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>
          {label}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          —
        </Typography.Text>
      </div>
    );
  }
  const pct = Math.round((used / total) * 100);
  const text =
    kind === 'memory'
      ? `${formatMB(used)} / ${formatMB(total)}`
      : kind === 'percent'
        ? `${used}% / ${total}%`
        : `${used} / ${total}`;
  return (
    <div style={{ marginBottom: 4 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 11,
        }}
      >
        <span style={{ color: 'rgba(0,0,0,0.45)' }}>{label}</span>
        <span style={{ color: 'rgba(0,0,0,0.65)' }}>{text}</span>
      </div>
      <Progress percent={pct} size="small" showInfo={false} />
    </div>
  );
};

const NodeStatusBadge: React.FC<{ status: string }> = ({ status }) => {
  switch (status) {
    case 'Ready':
      return <CheckCircleFilled style={{ color: '#52c41a' }} />;
    case 'NotReady':
      return <CloseCircleFilled style={{ color: '#ff4d4f' }} />;
    default:
      return <ExclamationCircleOutlined style={{ color: '#faad14' }} />;
  }
};

// ─── Section 4: Detail tabs (cards / tasks) ───────────────────────────────

const DetailTabs: React.FC<{
  nodes: GPUNodeSummary[];
  onCardDetail: (card: GPUCardSummary, node: string) => void;
}> = ({ nodes, onCardDetail }) => {
  const intl = useIntl();
  return (
    <Card>
      <Tabs
        items={[
          {
            key: 'cards',
            label: intl.formatMessage({
              id: 'pages.compute.overview.tab.cards',
            }),
            children: <CardsTable nodes={nodes} onDetail={onCardDetail} />,
          },
          {
            key: 'tasks',
            label: intl.formatMessage({
              id: 'pages.compute.overview.tab.tasks',
            }),
            children: <TasksTable nodes={nodes} />,
          },
        ]}
      />
    </Card>
  );
};

// ─── Cards table (flat across nodes) ──────────────────────────────────────

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

function flattenCards(nodes: GPUNodeSummary[]): CardRow[] {
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

const CardsTable: React.FC<{
  nodes: GPUNodeSummary[];
  onDetail: (card: GPUCardSummary, node: string) => void;
}> = ({ nodes, onDetail }) => {
  const intl = useIntl();
  const rows = useMemo(() => flattenCards(nodes), [nodes]);
  if (rows.length === 0) {
    return (
      <Empty
        description={intl.formatMessage({ id: 'pages.compute.cards.empty' })}
      />
    );
  }
  return (
    <Table<CardRow>
      size="middle"
      rowKey="uuid"
      pagination={{ pageSize: 10, showSizeChanger: true }}
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
          render: (v: string | undefined) => (v ? <Tag>{v}</Tag> : '—'),
        },
        {
          title: intl.formatMessage({ id: 'pages.compute.cards.col.node' }),
          dataIndex: 'nodeName',
          filters: Array.from(new Set(rows.map((r) => r.nodeName))).map(
            (n) => ({ text: n, value: n }),
          ),
          onFilter: (v, r) => r.nodeName === v,
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
                {intl.formatMessage({
                  id: 'pages.gpu.node.devices.health.bad',
                })}
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
            ) : (
              '—'
            ),
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
                format={() =>
                  `${formatMB(r.usedMem)} / ${formatMB(r.devmem)}`
                }
              />
            ) : (
              '—'
            ),
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
            ) : (
              '—'
            ),
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
              onClick={() => onDetail(r.raw, r.nodeName)}
            >
              {intl.formatMessage({ id: 'pages.compute.nodes.detail' })}
            </Button>
          ),
        },
      ]}
    />
  );
};

// ─── Tasks table (flat per-pod across cluster) ────────────────────────────

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

function buildTaskRows(nodes: GPUNodeSummary[]): TaskRow[] {
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
    // Phase + metadata come from the node-level pods list (per-card view
    // doesn't carry them). Fall back to node-level pods that have no
    // per-card detail (vanilla NVIDIA plugin) so they still appear here.
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

const TasksTable: React.FC<{ nodes: GPUNodeSummary[] }> = ({ nodes }) => {
  const intl = useIntl();
  const rows = useMemo(() => buildTaskRows(nodes), [nodes]);
  if (rows.length === 0) {
    return (
      <Empty
        description={intl.formatMessage({ id: 'pages.compute.tasks.empty' })}
      />
    );
  }
  return (
    <Table<TaskRow>
      size="middle"
      rowKey={(r) => `${r.namespace}/${r.name}/${r.node}`}
      pagination={{ pageSize: 10, showSizeChanger: true }}
      dataSource={rows}
      scroll={{ x: 'max-content' }}
      columns={[
        {
          title: intl.formatMessage({ id: 'pages.gpu.node.pods.namespace' }),
          dataIndex: 'namespace',
          sorter: (a, b) => a.namespace.localeCompare(b.namespace),
          filterSearch: true,
          filters: Array.from(new Set(rows.map((r) => r.namespace))).map(
            (ns) => ({ text: ns, value: ns }),
          ),
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
          title: intl.formatMessage({
            id: 'pages.compute.tasks.col.totalMem',
          }),
          dataIndex: 'totalMem',
          width: 130,
          align: 'right',
          sorter: (a, b) => a.totalMem - b.totalMem,
          render: (v: number) => formatMB(v),
        },
        {
          title: intl.formatMessage({
            id: 'pages.compute.tasks.col.totalCores',
          }),
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
          title: intl.formatMessage({
            id: 'pages.compute.tasks.col.priority',
          }),
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
  );
};

export default ComputeOverview;
