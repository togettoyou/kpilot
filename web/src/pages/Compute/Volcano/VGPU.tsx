import {
  ExclamationCircleFilled,
  InfoCircleOutlined,
  RocketOutlined,
} from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { history, useIntl, useParams, useRequest } from '@umijs/max';
import {
  Alert,
  Card as AntCard,
  Button,
  Col,
  Empty,
  Input,
  Row,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import React, { useMemo, useState } from 'react';

import { PodLogsDrawer } from '@/pages/ClusterDetail/Workloads/PodLogsDrawer';
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
  // Pod-logs drawer fed by clicks on pod names in the per-card
  // table. One shared state instead of one per row so memory stays
  // low on big clusters.
  const [podLogs, setPodLogs] = useState<{
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
      <ResourceIntro id="pages.compute.intro.vgpu" />
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
        onPodClick={(namespace, name) => setPodLogs({ namespace, name })}
      />

      <PodLogsDrawer
        open={!!podLogs}
        onClose={() => setPodLogs(null)}
        clusterId={clusterId}
        namespace={podLogs?.namespace ?? ''}
        podName={podLogs?.name ?? ''}
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
        return (
          // 6 columns at md+ → 4 cards span the full row. Title
          // minHeight matches Overview KPI row so values share a
          // baseline. Bar/chips row reserved at fixed height even
          // on bar-less KPIs so all 4 cards end at the same y.
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
                  minHeight: 40,
                }}
              >
                {intl.formatMessage({
                  id: `pages.compute.vgpu.kpi.${k.key}`,
                })}
              </div>
              <div
                style={{
                  fontSize: 24,
                  fontWeight: 500,
                  lineHeight: 1.4,
                  color: toneColor,
                }}
              >
                {String(k.value)}
                {k.suffix && (
                  <span style={{ fontSize: 14, marginInlineStart: 4 }}>
                    {k.suffix}
                  </span>
                )}
              </div>
              {/* Reserved slot — either a thin utilization bar
                  (slots / memory) or a chip row (cards / nodes).
                  Fixed height so the 4 cards stay aligned. */}
              <div
                style={{
                  minHeight: 18,
                  marginTop: 6,
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                {k.ratio !== undefined ? (
                  <div
                    style={{
                      flex: 1,
                      height: 6,
                      background: 'var(--ant-color-fill-tertiary)',
                      borderRadius: 2,
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${k.ratio * 100}%`,
                        height: '100%',
                        background: utilColor(k.ratio),
                      }}
                    />
                  </div>
                ) : (
                  k.chips
                )}
              </div>
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

  // Manual expansions persist across search clears — operators
  // expanded a particular node deliberately, the search filter
  // shouldn't lose that signal.
  const [manualExpanded, setManualExpanded] = useState<Set<string>>(
    () => new Set(),
  );
  const expandedRowKeys = useMemo<string[]>(() => {
    if (!trimmed) return [...manualExpanded];
    // Search active: union of user-expanded and search-matching
    // nodes so the operator never loses a row they deliberately
    // opened earlier.
    const out = new Set<string>(manualExpanded);
    for (const n of filteredNodes) out.add(n.name);
    return [...out];
  }, [filteredNodes, trimmed, manualExpanded]);

  const onExpandChange = (expanded: boolean, record: VGPUNode) => {
    setManualExpanded((prev) => {
      const next = new Set(prev);
      if (expanded) next.add(record.name);
      else next.delete(record.name);
      return next;
    });
  };

  // Single-model collapse: when every card in the cluster has the
  // same type (common case), drop the dedicated "types" column and
  // ride the model tag with the node name to save horizontal space.
  const singleType = useMemo<string | null>(() => {
    const set = new Set<string>();
    for (const n of nodes) for (const c of n.cards) set.add(c.type);
    return set.size === 1 ? [...set][0] : null;
  }, [nodes]);

  const columns: ProColumns<VGPUNode>[] = [
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.node.col.name' }),
      dataIndex: 'name',
      width: 320,
      fixed: 'left',
      render: (_, r) => (
        <Space size={6} wrap>
          {/* Node name → cluster-management Nodes page. Operators
              jump here to check taints / labels / k8s status. */}
          <a onClick={() => history.push(`/clusters/${clusterId}/nodes`)}>
            <Text strong style={{ fontSize: 13 }}>
              {r.name}
            </Text>
          </a>
          {r.healthy ? (
            <Tag color="green" style={{ marginInlineEnd: 0 }}>
              healthy
            </Tag>
          ) : (
            <Tag color="red" style={{ marginInlineEnd: 0 }}>
              degraded
            </Tag>
          )}
          {singleType && (
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              {singleType} × {r.cards.length}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.node.col.cards' }),
      key: 'cards',
      width: 80,
      sorter: (a, b) => a.cards.length - b.cards.length,
      render: (_, r) => r.cards.length,
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.node.col.slots' }),
      key: 'slots',
      width: 220,
      // Sort by utilization so the most-stressed bubbles up. Same
      // pattern as the Overview queue table.
      sorter: (a, b) =>
        ratio(a.usedNumber, a.totalNumber) -
        ratio(b.usedNumber, b.totalNumber),
      render: (_, r) => (
        <UtilBar used={r.usedNumber} total={r.totalNumber} unit="" />
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.node.col.memory' }),
      key: 'memory',
      width: 260,
      sorter: (a, b) =>
        ratio(a.usedMemory, a.totalMemory) -
        ratio(b.usedMemory, b.totalMemory),
      render: (_, r) => (
        <UtilBar used={r.usedMemory} total={r.totalMemory} unit="GiB" asGiB />
      ),
    },
    {
      // Compute share (cores) — aggregated client-side from the
      // per-card usedCores values. Each card contributes 100% of
      // capacity so node total = nCards × 100. Same UtilBar style
      // as slots/memory; same advisory tooltip note as the per-card
      // column inside the expanded row.
      title: (
        <Space size={4}>
          <span>
            {intl.formatMessage({ id: 'pages.compute.vgpu.node.col.cores' })}
          </span>
          <Tooltip
            title={intl.formatMessage({
              id: 'pages.compute.vgpu.card.col.cores.tip',
            })}
          >
            <InfoCircleOutlined
              style={{ color: 'var(--ant-color-text-tertiary)' }}
            />
          </Tooltip>
        </Space>
      ),
      key: 'cores',
      width: 200,
      sorter: (a, b) => nodeCores(a).used - nodeCores(b).used,
      render: (_, r) => {
        const c = nodeCores(r);
        return <UtilBar used={c.used} total={c.total} unit="%" percent />;
      },
    },
  ];
  if (!singleType) {
    columns.push({
      title: intl.formatMessage({ id: 'pages.compute.vgpu.node.col.types' }),
      key: 'types',
      width: 280,
      render: (_, r) => {
        const counts = new Map<string, number>();
        for (const c of r.cards) {
          counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
        }
        if (counts.size === 0) return <Text type="secondary">-</Text>;
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
    });
  }

  return (
    <ProTable<VGPUNode>
      rowKey="name"
      columns={columns}
      dataSource={filteredNodes}
      loading={loading}
      search={false}
      pagination={{ pageSize: 20, showSizeChanger: true }}
      scroll={{ x: 'max-content' }}
      options={{ reload: false }}
      expandable={{
        expandedRowRender: (record) => (
          <CardTable cards={record.cards} onPodClick={onPodClick} />
        ),
        rowExpandable: (record) => record.cards.length > 0,
        expandedRowKeys,
        onExpand: onExpandChange,
      }}
      headerTitle={
        // Node count + healthy/degraded breakdown lives on the table
        // header so the KPI row can use that vertical slot for the
        // Cores utilization KPI instead. Same numbers, more useful
        // adjacency (next to the actual node list).
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
          {(() => {
            let healthy = 0;
            for (const n of nodes) {
              if (n.healthy && n.cards.every((c) => c.health)) healthy += 1;
            }
            const degraded = nodes.length - healthy;
            if (nodes.length === 0) return null;
            return (
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
            );
          })()}
        </Space>
      }
      toolBarRender={() => [
        // Pod search — primary new affordance. Operators jump here
        // first when troubleshooting "where is this pod running".
        <Input.Search
          key="search"
          allowClear
          placeholder={intl.formatMessage({
            id: 'pages.compute.vgpu.search.placeholder',
          })}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 240 }}
        />,
        <RefreshControl
          key="refresh"
          interval={interval}
          setInterval={setInterval}
          refresh={refresh}
          loading={loading}
        />,
      ]}
      locale={{
        emptyText: trimmed ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={intl.formatMessage(
              { id: 'pages.compute.vgpu.search.empty' },
              { q: search },
            )}
          />
        ) : undefined,
      }}
    />
  );
}

// ─── Per-card nested table ───────────────────────────────────────────

function CardTable({
  cards,
  onPodClick,
}: {
  cards: VGPUCard[];
  onPodClick: (namespace: string, name: string) => void;
}) {
  const intl = useIntl();
  const columns: ProColumns<VGPUCard>[] = [
    {
      title: '#',
      key: 'identity',
      width: 220,
      render: (_, r) => (
        <Space direction="vertical" size={0} style={{ lineHeight: 1.3 }}>
          <Space size={6}>
            <Text strong style={{ fontSize: 13 }}>
              #{r.index}
            </Text>
            {r.health ? (
              <Tag color="green" style={{ marginInlineEnd: 0 }}>
                OK
              </Tag>
            ) : (
              <Tag color="red" style={{ marginInlineEnd: 0 }}>
                bad
              </Tag>
            )}
          </Space>
          {/* UUID tail-truncated — server-side UUIDs share fixed
              "GPU-" prefixes; trailing hex is what distinguishes
              cards. Copy button still copies the full UUID. */}
          <Text
            type="secondary"
            style={{ fontSize: 11 }}
            copyable={{ text: r.uuid, tooltips: false }}
          >
            {shortUuid(r.uuid)}
          </Text>
        </Space>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.card.col.type' }),
      key: 'type',
      width: 180,
      render: (_, r) => (
        <Space direction="vertical" size={0} style={{ lineHeight: 1.3 }}>
          <Text style={{ fontSize: 13 }}>{r.type}</Text>
          <Tag style={{ marginInlineEnd: 0, fontSize: 11 }}>
            {r.sharingMode}
          </Tag>
        </Space>
      ),
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
        <UtilBar used={r.usedMemory} total={r.memory} unit="GiB" asGiB />
      ),
    },
    {
      // Cores semantics: Volcano vGPU exposes a 0-100 percentage
      // for "compute share" — it's advisory (not enforced by HAMi
      // by default like memory is). The tooltip on the header
      // saves users from misreading it as a hard cap.
      title: (
        <Space size={4}>
          <span>
            {intl.formatMessage({ id: 'pages.compute.vgpu.card.col.cores' })}
          </span>
          <Tooltip
            title={intl.formatMessage({
              id: 'pages.compute.vgpu.card.col.cores.tip',
            })}
          >
            <InfoCircleOutlined
              style={{ color: 'var(--ant-color-text-tertiary)' }}
            />
          </Tooltip>
        </Space>
      ),
      key: 'cores',
      width: 200,
      render: (_, r) => (
        <UtilBar used={r.usedCores} total={100} unit="%" percent />
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.card.col.pods' }),
      key: 'pods',
      width: 260,
      render: (_, r) => (
        <PodsCell pods={r.pods ?? []} onPodClick={onPodClick} />
      ),
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
      headerTitle={false}
      toolBarRender={false}
    />
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
