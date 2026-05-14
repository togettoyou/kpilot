import { ExclamationCircleFilled } from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { useIntl, useParams, useRequest } from '@umijs/max';
import {
  Card as AntCard,
  Col,
  Row,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import React, { useMemo } from 'react';

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

// ─── Shared helpers ──────────────────────────────────────────────────

// formatGiB converts MiB → GiB with one decimal place. Wire format
// is MiB (matches `nvidia-smi --query-gpu=memory.total`); GiB is the
// natural display unit for cluster-scale totals — readers don't
// want to mentally divide 23028 / 1024 every time.
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

// ─── Cluster KPIs ────────────────────────────────────────────────────

interface Kpi {
  key: string;
  value: string | number;
  suffix?: string;
  ratio?: number; // 0..1 for the bar slot; undefined = no bar
  tone?: 'warn' | 'error' | 'ok';
}

function ClusterKPIs({
  snapshot,
  loading,
}: {
  snapshot: VGPUSnapshot | undefined;
  loading: boolean;
}) {
  const intl = useIntl();

  const kpis: Kpi[] = useMemo(() => {
    const totalCards = snapshot?.totalCards ?? 0;
    const totalSlots = snapshot?.totalSlots ?? 0;
    const usedSlots = snapshot?.usedSlots ?? 0;
    const totalMemory = snapshot?.totalMemory ?? 0;
    const usedMemory = snapshot?.usedMemory ?? 0;
    const nodeCount = snapshot?.nodes.length ?? 0;
    const slotRatio = ratio(usedSlots, totalSlots);
    const memRatio = ratio(usedMemory, totalMemory);
    return [
      { key: 'cards', value: totalCards },
      {
        key: 'slots',
        value: `${usedSlots} / ${totalSlots}`,
        ratio: slotRatio,
        tone:
          slotRatio >= 0.85
            ? 'error'
            : slotRatio >= 0.6
              ? 'warn'
              : undefined,
      },
      {
        key: 'memory',
        value: `${formatGiB(usedMemory)} / ${formatGiB(totalMemory)}`,
        suffix: 'GiB',
        ratio: memRatio,
        tone:
          memRatio >= 0.85
            ? 'error'
            : memRatio >= 0.6
              ? 'warn'
              : undefined,
      },
      { key: 'nodes', value: nodeCount },
    ];
  }, [snapshot]);

  return (
    <Row gutter={[12, 12]} style={{ marginBottom: 12 }} align="stretch">
      {kpis.map((k) => {
        const toneColor =
          k.tone === 'warn'
            ? 'var(--ant-color-warning)'
            : k.tone === 'error'
              ? 'var(--ant-color-error)'
              : k.tone === 'ok'
                ? 'var(--ant-color-success)'
                : undefined;
        return (
          // 6 columns at md+ → 4 cards span the full row. Title
          // minHeight matches the Overview KPI row so values share a
          // baseline even when one card's title wraps. Bar slot is
          // reserved with a fixed height (24px) even on bar-less
          // KPIs so all 4 cards end at the same y-coordinate.
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
              {/* Bar row — reserved height even when there's no bar
                  so KPI cards stay aligned. */}
              <div style={{ height: 12, marginTop: 6 }}>
                {k.ratio !== undefined && (
                  <div
                    style={{
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
}: {
  nodes: VGPUNode[];
  loading: boolean;
  interval: number;
  setInterval: (n: number) => void;
  refresh: () => void;
}) {
  const intl = useIntl();

  // Collapse the per-node "types" column when every node ends up
  // with the same single GPU model (the common case) — we surface
  // that one model in the node name cell instead, freeing column
  // width for the bars that actually need it.
  const singleType = useMemo<string | null>(() => {
    const set = new Set<string>();
    for (const n of nodes) for (const c of n.cards) set.add(c.type);
    return set.size === 1 ? [...set][0] : null;
  }, [nodes]);

  const columns: ProColumns<VGPUNode>[] = [
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.node.col.name' }),
      dataIndex: 'name',
      width: 280,
      fixed: 'left',
      render: (_, r) => (
        <Space size={6} wrap>
          <Text strong style={{ fontSize: 13 }}>
            {r.name}
          </Text>
          {/* Health tag and (when collapsed) the single GPU model
              ride with the name cell so they're glanceable on a
              narrow viewport without scrolling. */}
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
      render: (_, r) => r.cards.length,
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.node.col.slots' }),
      key: 'slots',
      width: 220,
      render: (_, r) => (
        <UtilBar used={r.usedNumber} total={r.totalNumber} unit="" />
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.node.col.memory' }),
      key: 'memory',
      width: 240,
      render: (_, r) => (
        <UtilBar
          used={r.usedMemory}
          total={r.totalMemory}
          unit="GiB"
          asGiB
        />
      ),
    },
  ];
  if (!singleType) {
    // Mixed-model cluster — keep the dedicated column so the user
    // can see at a glance which nodes have what.
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
      dataSource={nodes}
      loading={loading}
      search={false}
      pagination={{ pageSize: 20, showSizeChanger: true }}
      scroll={{ x: 'max-content' }}
      options={{ reload: false }}
      // Each node row expands into its per-card detail table — flat
      // top-level lists lost the "which node is hot" signal that
      // operators care about most.
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
      // Compact identity column: #N + health tag in one cell, then a
      // truncated UUID with a copy button below. Folds the previous
      // # / UUID / health columns into a single 220 px cell.
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
          <Text
            type="secondary"
            style={{ fontSize: 11 }}
            copyable={{ text: r.uuid, tooltips: false }}
          >
            {r.uuid.length > 14 ? `${r.uuid.slice(0, 14)}…` : r.uuid}
          </Text>
        </Space>
      ),
    },
    {
      // Model / sharing mode merged: model on top, sharing chip
      // underneath. Most nodes have one model and one sharing mode,
      // so this is virtually no extra info to parse — just visually
      // grouped.
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
        <UtilBar
          used={r.usedMemory}
          total={r.memory}
          unit="GiB"
          asGiB
        />
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.vgpu.card.col.cores' }),
      key: 'cores',
      width: 200,
      // Cores percentage is already 0..100, so the UtilBar denominator
      // is just the constant 100 — same visual language as memory and
      // slots, instead of the previous bare "0%" / "-".
      render: (_, r) => <UtilBar used={r.usedCores} total={100} unit="%" percent />,
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
    return (
      <Text type="secondary">
        {intl.formatMessage({ id: 'pages.compute.vgpu.card.pods.idle' })}
      </Text>
    );
  // A single pod may show up multiple times (one entry per slice it
  // allocated on this card) — collapse to "namespace/name × N" with
  // aggregated memory + cores on the tooltip.
  const counts = new Map<
    string,
    { count: number; mem: number; cores: number }
  >();
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
          title={`${formatGiB(agg.mem)} GiB · ${agg.cores}% cores${
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

// ─── Shared thin utilization bar ─────────────────────────────────────

// UtilBar is the single bar style used everywhere on this page —
// matches the Overview dashboard's queue table for visual rhythm.
// Three rendering modes:
//   asGiB  — display "used/total GiB" (memory)
//   percent — display "used%" alone (cores: total is always 100)
//   default — "used / total <unit>" (slots / counts)
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
