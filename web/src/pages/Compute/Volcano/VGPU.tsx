import {
  ExclamationCircleFilled,
  InfoCircleOutlined,
  RocketOutlined,
} from '@ant-design/icons';
import { history, useIntl, useParams, useRequest } from '@umijs/max';
import {
  Alert,
  Card as AntCard,
  Button,
  Col,
  Empty,
  Input,
  Progress,
  Row,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import React, { useMemo, useState } from 'react';

import { DescribeDrawer } from '@/pages/ClusterDetail/Workloads/DescribeDrawer';
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
  useAutoRefresh,
} from './shared/Layout';

const { Text } = Typography;

// /compute/:id/vgpu — projects every Node's vGPU register + every
// Pod's vgpu-ids-new annotation into:
//   1) a cluster KPI strip (cards / slots / memory / nodes) sharing
//      the visual rhythm of the Overview page's KPI row
//   2) an aggregated unhealthy-cards banner (top-of-page if any)
//   3) a per-node table with a search box + sortable utilization
//      columns + drilldown links from node/pod names
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

  // Pod search lifted up so both NodeTable + the banner can react
  // to it (banner stays visible regardless of filtering).
  const [search, setSearch] = useState('');
  // Pod describe drawer fed by clicks on pod names in the per-card
  // rows. Describe (instead of logs) because vGPU work is typically
  // about "where is this pod scheduled / what GPU did it get" — the
  // describe output spells out volcano.sh/vgpu-* annotations + node
  // assignment in one place. Logs are a click away on Workloads.
  const [describeTarget, setDescribeTarget] = useState<{
    namespace: string;
    name: string;
  } | null>(null);

  // All hooks MUST run on every render — the two derived counters
  // were once positioned below the NotInstalled early return, which
  // worked on the first render but threw "Rendered fewer hooks than
  // expected" the moment a request error flipped the branch. React
  // tracks hook order, not identity, so any conditional skip on a
  // hook call is a bug.
  const snapshot = data;
  const nodes = snapshot?.nodes ?? [];
  const unhealthyCards = useMemoUnhealthy(nodes);
  const totalRunningPods = useMemoRunningPods(nodes);
  const showEmptyCTA =
    !loading && !!snapshot && nodes.length > 0 && totalRunningPods === 0;

  if (!clusterId) return null;
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

  return (
    <div className="p-6">
      <ClusterKPIs snapshot={snapshot} loading={loading} />

      {/* Aggregated unhealthy banner — a top-level signal that
          beats scrolling through expanded rows to find red tags. */}
      {unhealthyCards.totalBad > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={intl.formatMessage(
            { id: 'pages.compute.vgpu.healthBanner.title' },
            {
              cards: unhealthyCards.totalBad,
              nodes: unhealthyCards.badNodes.size,
            },
          )}
          description={intl.formatMessage({
            id: 'pages.compute.vgpu.healthBanner.desc',
          })}
        />
      )}

      {/* Empty-state CTA — cluster has GPUs but no pods are
          actually using vGPU. Steers users at the Jobs page so
          they can submit a test workload. */}
      {showEmptyCTA && (
        <AntCard
          size="small"
          style={{ marginBottom: 12 }}
          styles={{ body: { padding: '14px 16px' } }}
        >
          <Space align="center" wrap>
            <RocketOutlined style={{ color: 'var(--ant-color-primary)' }} />
            <Text>
              {intl.formatMessage({ id: 'pages.compute.vgpu.empty.title' })}
            </Text>
            <Text type="secondary">
              {intl.formatMessage({ id: 'pages.compute.vgpu.empty.desc' })}
            </Text>
            <Button
              type="link"
              onClick={() => history.push(`/compute/${clusterId}/jobs`)}
            >
              {intl.formatMessage({ id: 'pages.compute.vgpu.empty.action' })}
            </Button>
          </Space>
        </AntCard>
      )}

      <NodeTable
        nodes={nodes}
        loading={loading}
        interval={interval}
        setInterval={setInterval}
        refresh={refresh}
        search={search}
        setSearch={setSearch}
        clusterId={clusterId}
        onPodClick={(namespace, name) =>
          setDescribeTarget({ namespace, name })
        }
      />

      <DescribeDrawer
        open={!!describeTarget}
        onClose={() => setDescribeTarget(null)}
        clusterId={clusterId}
        resourceType="pods"
        name={describeTarget?.name ?? ''}
        namespace={describeTarget?.namespace ?? ''}
      />
    </div>
  );
}

// ─── Aggregation helpers ─────────────────────────────────────────────

function useMemoUnhealthy(nodes: VGPUNode[]): {
  totalBad: number;
  badNodes: Set<string>;
} {
  return useMemo(() => {
    let totalBad = 0;
    const badNodes = new Set<string>();
    for (const n of nodes) {
      for (const c of n.cards) {
        if (!c.health) {
          totalBad += 1;
          badNodes.add(n.name);
        }
      }
      // Also count node-level health flag — controller marks a node
      // unhealthy when the heartbeat annotation goes stale even if
      // individual cards still report OK at last sync.
      if (!n.healthy) badNodes.add(n.name);
    }
    return { totalBad, badNodes };
  }, [nodes]);
}

function useMemoRunningPods(nodes: VGPUNode[]): number {
  return useMemo(() => {
    const seen = new Set<string>();
    for (const n of nodes) {
      for (const c of n.cards) {
        for (const p of c.pods ?? []) {
          seen.add(`${p.namespace}/${p.name}`);
        }
      }
    }
    return seen.size;
  }, [nodes]);
}

// ─── Shared helpers ──────────────────────────────────────────────────

// formatGiB converts MiB → GiB with one decimal place. Wire format
// is MiB (matches `nvidia-smi --query-gpu=memory.total`); GiB is the
// natural display unit for cluster-scale totals.
function formatGiB(mib: number): string {
  if (!Number.isFinite(mib) || mib <= 0) return '0';
  return (mib / 1024).toFixed(1);
}

function ratio(used: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(Math.max(used / total, 0), 1);
}

// Single source of truth for utilization colors across all the bars
// on this page — matches the Overview dashboard's queue table:
// red ≥ 85%, yellow ≥ 60%, green otherwise.
function utilColor(r: number): string {
  if (r >= 0.85) return '#ff4d4f';
  if (r >= 0.6) return '#faad14';
  return '#52c41a';
}

// Tail-bias UUID truncation. Server-side UUIDs come from NVML and
// share fixed prefixes (`GPU-`); operators identify cards by the
// trailing hex. So show "…<last 8>" instead of "<first 12>…".
function shortUuid(uuid: string): string {
  if (!uuid) return '-';
  if (uuid.length <= 12) return uuid;
  return `…${uuid.slice(-8)}`;
}

// nodeCores aggregates a node's per-card cores into one (used, total)
// pair. Total is nCards × 100 because each card exposes 100% of its
// compute. Used sums the per-card usedCores reported by the device-
// plugin. Server doesn't ship this aggregation in the VGPUNode shape,
// so we derive in the UI to avoid a worker-protocol change.
function nodeCores(n: VGPUNode): { used: number; total: number } {
  let used = 0;
  for (const c of n.cards) used += c.usedCores ?? 0;
  return { used, total: n.cards.length * 100 };
}

// ─── Cluster KPIs ────────────────────────────────────────────────────

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
  const nodes = snapshot?.nodes ?? [];
  const slotRatio = ratio(usedSlots, totalSlots);
  const memRatio = ratio(usedMemory, totalMemory);

  // Cores aren't aggregated server-side (VGPUSnapshot has totalSlots /
  // totalMemory but no totalCores). Sum here client-side from the per-
  // card data each node already carries — `total` is N×100 because each
  // card exposes 100% of its compute, `used` is whatever pods claimed
  // via volcano.sh/vgpu-cores. Keeps the calc in one place and avoids a
  // worker change for what's a pure derivation.
  const { totalCores, usedCores } = useMemo(() => {
    let total = 0;
    let used = 0;
    for (const n of nodes) {
      for (const c of n.cards) {
        total += 100;
        used += c.usedCores ?? 0;
      }
    }
    return { totalCores: total, usedCores: used };
  }, [nodes]);
  const coreRatio = ratio(usedCores, totalCores);

  // Per-model card inventory (e.g. "A10 × 4 · A100 × 2") — replaces
  // the empty bar slot on the "cards" KPI so mixed-model clusters
  // can be spotted immediately.
  const typeBreakdown = useMemo<[string, number][]>(() => {
    const counts = new Map<string, number>();
    for (const n of nodes) {
      for (const c of n.cards) {
        counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [nodes]);


  const kpis: Array<{
    key: string;
    value: string | number;
    suffix?: string;
    ratio?: number;
    chips?: React.ReactNode;
    tone?: 'warn' | 'error';
  }> = [
    {
      key: 'cards',
      value: totalCards,
      chips:
        typeBreakdown.length > 0 ? (
          <Space size={4} wrap>
            {typeBreakdown.slice(0, 3).map(([type, n]) => (
              <Tag
                key={type}
                color="blue"
                style={{ marginInlineEnd: 0, fontSize: 11 }}
              >
                {type} × {n}
              </Tag>
            ))}
            {typeBreakdown.length > 3 && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                +{typeBreakdown.length - 3}
              </Text>
            )}
          </Space>
        ) : null,
    },
    {
      key: 'slots',
      value: `${usedSlots} / ${totalSlots}`,
      ratio: slotRatio,
      tone:
        slotRatio >= 0.85 ? 'error' : slotRatio >= 0.6 ? 'warn' : undefined,
    },
    {
      key: 'memory',
      value: `${formatGiB(usedMemory)} / ${formatGiB(totalMemory)}`,
      suffix: 'GiB',
      ratio: memRatio,
      tone: memRatio >= 0.85 ? 'error' : memRatio >= 0.6 ? 'warn' : undefined,
    },
    {
      // Cores (compute share) used to only show inside the expanded
      // per-card row. Surfaced as a KPI so users get a cluster-wide
      // utilization signal without expanding any nodes. Node count +
      // healthy/degraded distribution moved into the NodeTable header
      // (one less "what does this number mean" cognitive hop).
      key: 'cores',
      value: `${usedCores} / ${totalCores}`,
      suffix: '%',
      ratio: coreRatio,
      tone:
        coreRatio >= 0.85 ? 'error' : coreRatio >= 0.6 ? 'warn' : undefined,
    },
  ];

  return (
    <Row gutter={[12, 12]} style={{ marginBottom: 12 }} align="stretch">
      {kpis.map((k) => {
        const toneColor =
          k.tone === 'warn'
            ? 'var(--ant-color-warning)'
            : k.tone === 'error'
              ? 'var(--ant-color-error)'
              : undefined;
        const pct = Math.round((k.ratio ?? 0) * 100);
        return (
          <Col key={k.key} xs={12} sm={12} md={6} lg={6} xl={6}>
            <AntCard
              size="small"
              loading={loading && !snapshot}
              style={{ height: '100%' }}
              styles={{ body: { padding: '12px 16px' } }}
            >
              <div
                style={{
                  fontSize: 14,
                  color: 'var(--ant-color-text-secondary)',
                  lineHeight: 1.4,
                  marginBottom: 8,
                }}
              >
                {intl.formatMessage({
                  id: `pages.compute.vgpu.kpi.${k.key}`,
                })}
              </div>
              {k.ratio !== undefined ? (
                // antd Progress.dashboard renders a 3/4-arc ring
                // gauge — picked over @ant-design/plots Gauge because
                // it's in the bundle already (no extra ~250 KB) and
                // the look is cleaner for these small KPI tiles.
                // strokeColor follows the same red/yellow/green
                // thresholds the page uses everywhere else.
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                  }}
                >
                  <Progress
                    type="dashboard"
                    percent={pct}
                    size={110}
                    strokeColor={utilColor(k.ratio)}
                    format={() => (
                      <span style={{ color: toneColor, fontSize: 20, fontWeight: 600 }}>
                        {pct}%
                      </span>
                    )}
                  />
                  <Text
                    type="secondary"
                    style={{ fontSize: 12, marginTop: 4, textAlign: 'center' }}
                  >
                    {String(k.value)}
                    {k.suffix ? ` ${k.suffix}` : ''}
                  </Text>
                </div>
              ) : (
                // Non-utilization tile (cards count). Big number +
                // optional chips — same vertical real estate as the
                // dashboard gauges so the row stays aligned.
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    minHeight: 138,
                    justifyContent: 'center',
                  }}
                >
                  <div
                    style={{
                      fontSize: 40,
                      fontWeight: 600,
                      lineHeight: 1.1,
                      color: toneColor,
                    }}
                  >
                    {String(k.value)}
                    {k.suffix && (
                      <span style={{ fontSize: 16, marginInlineStart: 4 }}>
                        {k.suffix}
                      </span>
                    )}
                  </div>
                  {k.chips && (
                    <div style={{ marginTop: 8 }}>{k.chips}</div>
                  )}
                </div>
              )}
            </AntCard>
          </Col>
        );
      })}
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
  search,
  setSearch,
  clusterId,
  onPodClick,
}: {
  nodes: VGPUNode[];
  loading: boolean;
  interval: number;
  setInterval: (n: number) => void;
  refresh: () => void;
  search: string;
  setSearch: (s: string) => void;
  clusterId: string;
  onPodClick: (namespace: string, name: string) => void;
}) {
  const intl = useIntl();

  // Search filters nodes whose name OR any pod's namespace/name
  // matches. Matching nodes get auto-expanded so the operator can
  // see the pod inside without an extra click.
  const trimmed = search.trim().toLowerCase();
  const filteredNodes = useMemo(() => {
    if (!trimmed) return nodes;
    return nodes.filter((n) => {
      if (n.name.toLowerCase().includes(trimmed)) return true;
      for (const c of n.cards) {
        for (const p of c.pods ?? []) {
          if (
            p.name.toLowerCase().includes(trimmed) ||
            p.namespace.toLowerCase().includes(trimmed) ||
            `${p.namespace}/${p.name}`.toLowerCase().includes(trimmed)
          )
            return true;
        }
      }
      return false;
    });
  }, [nodes, trimmed]);

  // Single-model collapse: when every card in the cluster has the
  // same type (common case), the per-node model tag rides next to
  // the node name; the dedicated "types" chip row is skipped.
  const singleType = useMemo<string | null>(() => {
    const set = new Set<string>();
    for (const n of nodes) for (const c of n.cards) set.add(c.type);
    return set.size === 1 ? [...set][0] : null;
  }, [nodes]);

  // Healthy / degraded breakdown surfaced in the section header so
  // the operator sees fleet health without scrolling.
  const { healthy, degraded } = useMemo(() => {
    let h = 0;
    for (const n of nodes) {
      if (n.healthy && n.cards.every((c) => c.health)) h += 1;
    }
    return { healthy: h, degraded: nodes.length - h };
  }, [nodes]);

  return (
    <AntCard
      size="small"
      loading={loading && nodes.length === 0}
      style={{ marginBottom: 12 }}
      title={
        // Header line stays inside the card chrome — node count +
        // healthy/degraded ride alongside the title; search + refresh
        // align to the right via `extra`.
        <Space size={12} wrap>
          <Text strong>
            {intl.formatMessage({ id: 'pages.compute.vgpu.node.title' })}
          </Text>
          <Text type="secondary">
            ({filteredNodes.length}
            {trimmed && filteredNodes.length !== nodes.length
              ? ` / ${nodes.length}`
              : ''}
            )
          </Text>
          {nodes.length > 0 && (
            <Space size={6}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                <span style={{ color: 'var(--ant-color-success)' }}>●</span>{' '}
                {intl.formatMessage(
                  { id: 'pages.compute.vgpu.kpi.nodes.healthy' },
                  { n: healthy },
                )}
              </Text>
              {degraded > 0 && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  <span style={{ color: 'var(--ant-color-error)' }}>●</span>{' '}
                  {intl.formatMessage(
                    { id: 'pages.compute.vgpu.kpi.nodes.degraded' },
                    { n: degraded },
                  )}
                </Text>
              )}
            </Space>
          )}
        </Space>
      }
      extra={
        <Space size={8}>
          <Input.Search
            allowClear
            placeholder={intl.formatMessage({
              id: 'pages.compute.vgpu.search.placeholder',
            })}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 240 }}
          />
          <RefreshControl
            interval={interval}
            setInterval={setInterval}
            refresh={refresh}
            loading={loading}
          />
        </Space>
      }
      styles={{ body: { padding: 0 } }}
    >
      {filteredNodes.length === 0 ? (
        <div style={{ padding: 32 }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              trimmed
                ? intl.formatMessage(
                    { id: 'pages.compute.vgpu.search.empty' },
                    { q: search },
                  )
                : undefined
            }
          />
        </div>
      ) : (
        // Card-per-node list: each node renders its summary bars
        // PLUS every physical card with all metrics inline by
        // default. Replaces the nested-table-with-expand pattern
        // that hid GPU detail behind a click and made the page
        // unscannable for "how full is each card on each node".
        <Space direction="vertical" size={12} style={{ width: '100%', padding: 12 }}>
          {filteredNodes.map((n) => (
            <NodeCard
              key={n.name}
              node={n}
              singleType={singleType}
              clusterId={clusterId}
              onPodClick={onPodClick}
            />
          ))}
        </Space>
      )}
    </AntCard>
  );
}

// NodeCard renders one node's full state: header (name + health +
// model badge + drilldown link) → node-wide aggregated bars (slots
// / memory / cores) → list of physical cards each with their own
// metrics + pods. Everything visible at once — no expand toggle.
function NodeCard({
  node,
  singleType,
  clusterId,
  onPodClick,
}: {
  node: VGPUNode;
  singleType: string | null;
  clusterId: string;
  onPodClick: (namespace: string, name: string) => void;
}) {
  const intl = useIntl();
  const cores = nodeCores(node);
  // For mixed-model clusters, summarise this node's models as a
  // single line of chips rather than a full column.
  const typeBadges = useMemo<[string, number][]>(() => {
    if (singleType) return [[singleType, node.cards.length]];
    const counts = new Map<string, number>();
    for (const c of node.cards) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
    return [...counts.entries()];
  }, [node, singleType]);

  return (
    <AntCard
      size="small"
      styles={{ body: { padding: '12px 16px' } }}
      style={{ background: 'var(--ant-color-fill-quaternary)' }}
    >
      {/* Node header — name link, health, model breakdown. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 10,
        }}
      >
        <a onClick={() => history.push(`/clusters/${clusterId}/nodes`)}>
          <Text strong style={{ fontSize: 14 }}>
            {node.name}
          </Text>
        </a>
        {node.healthy ? (
          <Tag color="green" style={{ marginInlineEnd: 0 }}>
            healthy
          </Tag>
        ) : (
          <Tag color="red" style={{ marginInlineEnd: 0 }}>
            degraded
          </Tag>
        )}
        {typeBadges.map(([t, n]) => (
          <Tag key={t} color="blue" style={{ marginInlineEnd: 0 }}>
            {t} × {n}
          </Tag>
        ))}
      </div>
      {/* Node-wide aggregates: three bars in one row, each one a
          labeled slot. Lets the operator scan "is this node hot"
          without reading any of the per-card detail below. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: 16,
          marginBottom: 12,
        }}
      >
        <LabeledBar
          label={intl.formatMessage({ id: 'pages.compute.vgpu.node.col.slots' })}
          used={node.usedNumber}
          total={node.totalNumber}
        />
        <LabeledBar
          label={intl.formatMessage({
            id: 'pages.compute.vgpu.node.col.memory',
          })}
          used={node.usedMemory}
          total={node.totalMemory}
          asGiB
        />
        <LabeledBar
          label={intl.formatMessage({ id: 'pages.compute.vgpu.node.col.cores' })}
          used={cores.used}
          total={cores.total}
          percent
          tipId="pages.compute.vgpu.card.col.cores.tip"
        />
      </div>
      {/* Physical cards in this node — each row shows everything in
          one line: identity + bars + pods. No separate columns to
          mentally align. */}
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {node.cards.map((card) => (
          <CardRow key={card.uuid} card={card} onPodClick={onPodClick} />
        ))}
      </Space>
    </AntCard>
  );
}

// CardRow — one physical GPU as a horizontal row. Identity on the
// left, 3 bars in the middle, pods on the right. Replaces the
// nested ProTable that previously rendered per-card data as a wall
// of column cells.
function CardRow({
  card,
  onPodClick,
}: {
  card: VGPUCard;
  onPodClick: (namespace: string, name: string) => void;
}) {
  const intl = useIntl();
  return (
    <div
      style={{
        display: 'grid',
        // identity 220 | three bars 1fr each | pods 280
        gridTemplateColumns: '220px 1fr 1fr 1fr 280px',
        gap: 16,
        alignItems: 'center',
        padding: '8px 12px',
        background: 'var(--ant-color-bg-container)',
        borderRadius: 4,
        border: '1px solid var(--ant-color-border-secondary)',
      }}
    >
      <div>
        <Space size={6}>
          <Text strong style={{ fontSize: 13 }}>
            #{card.index}
          </Text>
          <Text style={{ fontSize: 12 }}>{card.type}</Text>
          {card.health ? (
            <Tag color="green" style={{ marginInlineEnd: 0, fontSize: 11 }}>
              OK
            </Tag>
          ) : (
            <Tag color="red" style={{ marginInlineEnd: 0, fontSize: 11 }}>
              bad
            </Tag>
          )}
        </Space>
        <div style={{ marginTop: 2 }}>
          <Text
            type="secondary"
            style={{ fontSize: 11 }}
            copyable={{ text: card.uuid, tooltips: false }}
          >
            {shortUuid(card.uuid)}
          </Text>
          <Tag
            style={{
              marginInlineStart: 6,
              marginInlineEnd: 0,
              fontSize: 11,
            }}
          >
            {card.sharingMode}
          </Tag>
        </div>
      </div>
      <UtilBar used={card.usedNumber} total={card.number} unit="" />
      <UtilBar used={card.usedMemory} total={card.memory} unit="GiB" asGiB />
      <UtilBar used={card.usedCores} total={100} unit="%" percent />
      <PodsCell pods={card.pods ?? []} onPodClick={onPodClick} />
    </div>
  );
}

// LabeledBar — variant of UtilBar with a label above it, for the
// node-aggregate row at the top of each NodeCard.
function LabeledBar({
  label,
  used,
  total,
  asGiB,
  percent,
  tipId,
}: {
  label: string;
  used: number;
  total: number;
  asGiB?: boolean;
  percent?: boolean;
  tipId?: string;
}) {
  const intl = useIntl();
  return (
    <div>
      <div
        style={{
          fontSize: 12,
          color: 'var(--ant-color-text-secondary)',
          marginBottom: 4,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <span>{label}</span>
        {tipId && (
          <Tooltip title={intl.formatMessage({ id: tipId })}>
            <InfoCircleOutlined
              style={{ color: 'var(--ant-color-text-tertiary)' }}
            />
          </Tooltip>
        )}
      </div>
      <UtilBar
        used={used}
        total={total}
        unit={asGiB ? 'GiB' : percent ? '%' : ''}
        asGiB={asGiB}
        percent={percent}
      />
    </div>
  );
}

function PodsCell({
  pods,
  onPodClick,
}: {
  pods: { namespace: string; name: string; usedMemory: number; usedCores: number }[];
  onPodClick: (namespace: string, name: string) => void;
}) {
  const intl = useIntl();
  if (pods.length === 0)
    return (
      <Text type="secondary">
        {intl.formatMessage({ id: 'pages.compute.vgpu.card.pods.idle' })}
      </Text>
    );
  const counts = new Map<
    string,
    { namespace: string; name: string; count: number; mem: number; cores: number }
  >();
  for (const p of pods) {
    const key = `${p.namespace}/${p.name}`;
    const prev = counts.get(key);
    if (prev) {
      prev.count += 1;
      prev.mem += p.usedMemory;
      prev.cores += p.usedCores;
    } else {
      counts.set(key, {
        namespace: p.namespace,
        name: p.name,
        count: 1,
        mem: p.usedMemory,
        cores: p.usedCores,
      });
    }
  }
  return (
    <Space direction="vertical" size={2} style={{ lineHeight: 1.4 }}>
      {[...counts.values()].map((agg) => {
        const key = `${agg.namespace}/${agg.name}`;
        return (
          <Tooltip
            key={key}
            title={`${formatGiB(agg.mem)} GiB · ${agg.cores}% cores${
              agg.count > 1 ? ` · ${agg.count} slices` : ''
            }`}
          >
            <a
              onClick={() => onPodClick(agg.namespace, agg.name)}
              style={{ fontSize: 12 }}
            >
              {key}
              {agg.count > 1 ? ` × ${agg.count}` : ''}
            </a>
          </Tooltip>
        );
      })}
    </Space>
  );
}

// ─── Shared thin utilization bar ─────────────────────────────────────

// UtilBar — single bar style used everywhere on this page; matches
// the Overview dashboard's queue table for visual rhythm.
//   asGiB   — display "used/total GiB" (memory)
//   percent — display "used%" alone (cores: total is always 100)
//   default — "used/total <unit>" (slot counts)
function UtilBar({
  used,
  total,
  unit,
  asGiB,
  percent,
}: {
  used: number;
  total: number;
  unit: string;
  asGiB?: boolean;
  percent?: boolean;
}) {
  if (total <= 0 && used <= 0) {
    return (
      <span style={{ color: 'var(--ant-color-text-quaternary)', fontSize: 13 }}>
        —
      </span>
    );
  }
  const r = ratio(used, total);
  const color = utilColor(r);
  const overloaded = r >= 0.85;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          flex: 1,
          minWidth: 40,
          height: 8,
          background: 'var(--ant-color-fill-tertiary)',
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${r * 100}%`,
            height: '100%',
            background: color,
          }}
        />
      </div>
      <div
        style={{
          fontSize: 12,
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--ant-color-text-secondary)',
          whiteSpace: 'nowrap',
        }}
      >
        {percent ? (
          <>{used}%</>
        ) : asGiB ? (
          <>
            {formatGiB(used)}/{formatGiB(total)}
            {unit ? ` ${unit}` : ''}
          </>
        ) : (
          <>
            {used}/{total}
            {unit ? ` ${unit}` : ''}
          </>
        )}
        <span style={{ color, fontWeight: 600, marginInlineStart: 4 }}>
          {(r * 100).toFixed(0)}%
        </span>
      </div>
      {overloaded && (
        <ExclamationCircleFilled
          style={{ color: '#ff4d4f', fontSize: 12, flexShrink: 0 }}
        />
      )}
    </div>
  );
}
