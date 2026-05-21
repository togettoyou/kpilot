import {
  AlertOutlined,
  AppstoreOutlined,
  BranchesOutlined,
  CrownOutlined,
} from '@ant-design/icons';
import { useIntl, useParams } from '@umijs/max';
import {
  Alert,
  Badge,
  Card,
  Empty,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useThemeMode } from 'antd-style';
import React, { useMemo, useState } from 'react';
import { useClusterRequest } from '@/hooks/useClusterRequest';

import {
  listVolcanoQueues,
  type QueueRow,
} from '@/services/kpilot/volcano-list';

import {
  isResourceNotAvailable,
  NotInstalled,
  RefreshControl,
  useAutoRefresh,
} from './shared/Layout';
import { parseQuantity } from './shared/utils';

// QueueQuota — cluster-scoped专题页 for inspecting per-queue capacity,
// guarantee and allocated for every resource the queue references.
// Sister to Overview: Overview shows cluster-wide rollups, QueueQuota
// drills into one queue at a time with all resource types broken out.
//
// Data flow: one /volcano/queues list call (already returns spec.{capability,
// guarantee, deserved, priority} + status.allocated after P14a's queueRow
// extension). Tree of subqueues built client-side from spec.parent.

// Resources we know how to label / unit-format. Anything else falls
// back to raw-name display with parseQuantity for the value.
const KNOWN_RESOURCES: Array<{
  key: string;
  // Units are kept in ASCII (cores / GiB / MiB / %) so the column
  // suffix is locale-neutral — the localized resource name to the left
  // ("CPU" / "内存" / etc.) carries the human context. Localized
  // singular nouns like "片" / "slice" belong in the resource label,
  // not the unit suffix, otherwise they leak into the wrong locale.
  unit?: string;
  // valueScale lets us render memory in GiB instead of raw bytes.
  // Applied AFTER parseQuantity, so input is the parsed numeric value.
  valueScale?: number;
}> = [
  { key: 'cpu', unit: 'cores' },
  { key: 'memory', unit: 'GiB', valueScale: 1 / 1024 ** 3 },
  { key: 'nvidia.com/gpu', unit: 'cards' },
  // vgpu-number's localized noun ("切片数" / "vGPU slots") is already
  // baked into the resource label; no unit suffix needed.
  { key: 'volcano.sh/vgpu-number' },
  { key: 'volcano.sh/vgpu-memory', unit: 'MiB' },
  { key: 'volcano.sh/vgpu-cores', unit: '%' },
];

function resourceMeta(key: string): { unit?: string; scale: number } {
  const hit = KNOWN_RESOURCES.find((r) => r.key === key);
  return { unit: hit?.unit, scale: hit?.valueScale ?? 1 };
}

// Order known resources first (in the explicit ordering above), then
// any others alphabetically. Used to keep the per-resource rows stable
// across refreshes.
function sortResourceKeys(keys: string[]): string[] {
  const known = KNOWN_RESOURCES.map((r) => r.key);
  const inKnown = keys
    .filter((k) => known.includes(k))
    .sort((a, b) => known.indexOf(a) - known.indexOf(b));
  const others = keys.filter((k) => !known.includes(k)).sort();
  return [...inKnown, ...others];
}

const QueueQuotaPage: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId = '' } = useParams<{ id: string }>();
  const { appearance } = useThemeMode();
  const dark = appearance === 'dark';

  const [selectedQueue, setSelectedQueue] = useState<string | null>(null);

  const { data, loading, error, refresh } = useClusterRequest(
    () => listVolcanoQueues(clusterId, { limit: 500 }),
    [clusterId],
    { ready: !!clusterId },
  );

  // Default to the "root" queue once data loads — Volcano always
  // ships a root queue (it's the implicit parent of every queue
  // without an explicit parent), and on a fresh cluster it's the
  // only thing to look at. Picking it on first render saves the
  // user a click; if there's no root (e.g. all queues have custom
  // names), the Empty CTA still prompts them to select.
  React.useEffect(() => {
    if (selectedQueue !== null) return;
    if (!data?.items?.length) return;
    const rootByName = data.items.find((q) => q.name === 'root');
    const initial = rootByName?.name ?? data.items[0]?.name;
    if (initial) setSelectedQueue(initial);
  }, [data, selectedQueue]);

  // Polling is opt-in; useAutoRefresh starts at 0 (off) and the
  // RefreshControl dropdown lets the user pick a cadence.
  const [interval, setInter] = useAutoRefresh(refresh, !!data);

  // IMPORTANT: every useMemo below must fire on every render — the
  // RESOURCE_NOT_AVAILABLE branch returns later but only AFTER all
  // hooks have been called. An early-return between hooks here used
  // to throw "Rendered fewer hooks than expected" the first time a
  // cluster without Volcano installed hit this page.
  const queues: QueueRow[] = data?.items ?? [];

  // Build a name → row map and a parent → children adjacency map.
  const byName = useMemo(() => {
    const m = new Map<string, QueueRow>();
    for (const q of queues) m.set(q.name, q);
    return m;
  }, [queues]);
  const childrenOf = useMemo(() => {
    const m = new Map<string, QueueRow[]>();
    for (const q of queues) {
      const parent = q.parent || '';
      const arr = m.get(parent) ?? [];
      arr.push(q);
      m.set(parent, arr);
    }
    return m;
  }, [queues]);

  // Sort options with indent so parents are visually grouped. We don't
  // need a full tree component in the select — antd's Cascader is
  // overkill for selecting a single queue.
  const queueOptions = useMemo(() => {
    const out: { value: string; label: React.ReactNode }[] = [];
    const visit = (q: QueueRow, depth: number) => {
      out.push({
        value: q.name,
        label: (
          <span>
            {depth > 0 && (
              <span style={{ opacity: 0.5 }}>
                {'│   '.repeat(depth - 1)}
                {'├─ '}
              </span>
            )}
            {q.name}
            {q.state && q.state !== 'Open' && (
              <Tag style={{ marginLeft: 6 }} color="default">
                {q.state}
              </Tag>
            )}
          </span>
        ),
      });
      const kids = (childrenOf.get(q.name) ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const k of kids) visit(k, depth + 1);
    };
    // Roots = queues with empty parent or parent not in cluster.
    const roots = queues
      .filter((q) => !q.parent || !byName.has(q.parent))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const r of roots) visit(r, 0);
    return out;
  }, [queues, byName, childrenOf]);

  const selected = selectedQueue ? byName.get(selectedQueue) : undefined;
  const selectedChildren = selectedQueue
    ? (childrenOf.get(selectedQueue) ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  // All hooks above. From here it's safe to conditionally return
  // different JSX without changing the hook count.
  if (error && isResourceNotAvailable(error)) {
    return <NotInstalled clusterId={clusterId} />;
  }

  return (
    <div className="p-6">
      <Spin spinning={loading && !data}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {/* Top filter row — Queue selector with the indented tree
             option list so parent / child relationships are obvious
             without leaving the select. RefreshControl rides along on
             the right to match the in-page-toolbar pattern the rest
             of the Compute platform uses (no breadcrumb / page title
             — those duplicate the sider). */}
          <Card size="small">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <Space wrap style={{ flex: 1, minWidth: 0 }}>
                <span>
                  {intl.formatMessage({
                    id: 'pages.queueQuota.selector.label',
                  })}
                </span>
                <Select
                  style={{ minWidth: 280 }}
                  placeholder={intl.formatMessage({
                    id: 'pages.queueQuota.selector.placeholder',
                  })}
                  allowClear
                  value={selectedQueue ?? undefined}
                  onChange={(v) => setSelectedQueue(v ?? null)}
                  options={queueOptions}
                  optionLabelProp="value"
                  showSearch
                  filterOption={(input, option) =>
                    String(option?.value ?? '')
                      .toLowerCase()
                      .includes(input.toLowerCase())
                  }
                />
                <Typography.Text type="secondary">
                  {intl.formatMessage(
                    { id: 'pages.queueQuota.summary' },
                    { total: queues.length },
                  )}
                </Typography.Text>
              </Space>
              <RefreshControl
                interval={interval}
                setInterval={setInter}
                loading={loading}
                refresh={refresh}
              />
            </div>
          </Card>

          {!selected ? (
            <Card>
              <Empty
                description={intl.formatMessage({
                  id: 'pages.queueQuota.empty.cta',
                })}
              />
            </Card>
          ) : (
            <>
              <QueueDetailCard
                queue={selected}
                dark={dark}
                primary
                clusterCap={data?.clusterAllocatable}
              />
              {selectedChildren.length > 0 && (
                <Card
                  size="small"
                  title={
                    <Space>
                      <BranchesOutlined />
                      {intl.formatMessage(
                        { id: 'pages.queueQuota.children.title' },
                        { count: selectedChildren.length },
                      )}
                    </Space>
                  }
                >
                  <Space
                    direction="vertical"
                    size="middle"
                    style={{ width: '100%' }}
                  >
                    {selectedChildren.map((c) => (
                      <QueueDetailCard
                        key={c.name}
                        queue={c}
                        dark={dark}
                        primary={false}
                        clusterCap={data?.clusterAllocatable}
                      />
                    ))}
                  </Space>
                </Card>
              )}
            </>
          )}
        </Space>
      </Spin>
    </div>
  );
};

export default QueueQuotaPage;

// QueueDetailCard renders one queue's header (state / parent / weight /
// priority / reclaimable) and a stack of per-resource bars (capability
// / guarantee / allocated / deserved). `primary` controls the visual
// weight — the user-selected queue gets the prominent card; subqueues
// render the same content with less padding / no border emphasis.
function QueueDetailCard({
  queue,
  dark,
  primary,
  clusterCap,
}: {
  queue: QueueRow;
  dark: boolean;
  primary: boolean;
  // Cluster-wide physical Allocatable per resource — used as the
  // bar denominator when the queue itself has no spec.capability
  // for that resource, so the UI shows "用了 X / 集群可用 Y"
  // instead of the previous "unbounded" state which gave no
  // actionable signal.
  clusterCap?: Record<string, string>;
}) {
  const intl = useIntl();

  const resources = useMemo(() => {
    const keys = new Set<string>();
    [
      queue.capability,
      queue.guarantee,
      queue.allocated,
      queue.deserved,
    ].forEach((m) => {
      if (m) for (const k of Object.keys(m)) keys.add(k);
    });
    return sortResourceKeys([...keys]);
  }, [queue]);

  return (
    <Card
      size={primary ? 'default' : 'small'}
      title={
        <Space wrap>
          <AppstoreOutlined />
          <Typography.Text strong>{queue.name}</Typography.Text>
          {queue.state && (
            <Tag color={queue.state === 'Open' ? 'green' : 'default'}>
              {queue.state}
            </Tag>
          )}
          {queue.parent && (
            <Tag color="blue" icon={<BranchesOutlined />}>
              {intl.formatMessage(
                { id: 'pages.queueQuota.card.parent' },
                { parent: queue.parent },
              )}
            </Tag>
          )}
          {typeof queue.priority === 'number' && queue.priority > 0 && (
            <Tag color="gold" icon={<CrownOutlined />}>
              {intl.formatMessage(
                { id: 'pages.queueQuota.card.priority' },
                { priority: queue.priority },
              )}
            </Tag>
          )}
          <Tag>
            {intl.formatMessage(
              { id: 'pages.queueQuota.card.weight' },
              { weight: queue.weight },
            )}
          </Tag>
          {queue.reclaimable === false && (
            <Tag color="orange">
              {intl.formatMessage({
                id: 'pages.queueQuota.card.nonReclaimable',
              })}
            </Tag>
          )}
        </Space>
      }
      extra={
        <Space size="small">
          <Badge
            status="processing"
            text={intl.formatMessage(
              { id: 'pages.queueQuota.card.running' },
              { n: queue.running },
            )}
          />
          <Badge
            status="warning"
            text={intl.formatMessage(
              { id: 'pages.queueQuota.card.pending' },
              { n: queue.pending },
            )}
          />
          <Badge
            status="default"
            text={intl.formatMessage(
              { id: 'pages.queueQuota.card.inqueue' },
              { n: queue.inqueue },
            )}
          />
        </Space>
      }
    >
      {resources.length === 0 ? (
        <Typography.Text type="secondary">
          {intl.formatMessage({ id: 'pages.queueQuota.noResources' })}
        </Typography.Text>
      ) : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {resources.map((k) => (
            <ResourceQuotaRow
              key={k}
              resourceKey={k}
              capability={queue.capability?.[k]}
              guarantee={queue.guarantee?.[k]}
              allocated={queue.allocated?.[k]}
              deserved={queue.deserved?.[k]}
              clusterCap={clusterCap?.[k]}
              dark={dark}
            />
          ))}
        </Space>
      )}
    </Card>
  );
}

// ResourceQuotaRow — one row per resource type. Layout:
//
//   ┌ CPU (cores) ────────────────────────────────────────┐
//   │ allocated 35 / guarantee 20 / capability 100          │
//   │ ████████████████░░░│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
//   │                    ▲                                  │
//   │                guarantee tick                         │
//   └───────────────────────────────────────────────────────┘
//
// Three states pile onto one bar: full track = capability, fill =
// allocated, tick = guarantee. Deserved (when present) is rendered
// as a secondary tick in a different colour. Unbounded queues drop
// the bar and render only the allocated number.
function ResourceQuotaRow({
  resourceKey,
  capability,
  guarantee,
  allocated,
  deserved,
  clusterCap,
  dark,
}: {
  resourceKey: string;
  capability?: string;
  guarantee?: string;
  allocated?: string;
  deserved?: string;
  // Cluster physical Allocatable for this resource (fallback
  // when `capability` is unset). When both are absent the row
  // genuinely has no upper bound and falls back to the old
  // striped-track "unbounded" rendering.
  clusterCap?: string;
  dark: boolean;
}) {
  const intl = useIntl();
  const { token } = theme.useToken();
  const meta = resourceMeta(resourceKey);

  const allocN = parseQuantity(allocated) * meta.scale;
  const explicitCapN = parseQuantity(capability) * meta.scale;
  const clusterCapN = parseQuantity(clusterCap) * meta.scale;
  const guarN = parseQuantity(guarantee) * meta.scale;
  const desN = parseQuantity(deserved) * meta.scale;

  // Effective bound: prefer the queue's own spec.capability; fall
  // back to the cluster physical Allocatable; show "unbounded"
  // only when both are missing (rare — most clusters always have
  // a Node Allocatable for the resource a queue's allocated against).
  const capN = explicitCapN > 0 ? explicitCapN : clusterCapN;
  const usingClusterCap = explicitCapN <= 0 && clusterCapN > 0;
  const unbounded = capN <= 0;
  const overcommit = !unbounded && allocN > capN;
  const unmetGuarantee = guarN > 0 && allocN < guarN;

  // Percentages — pegged to capability when bounded; the unbounded
  // case shows an empty striped track (matching Overview's
  // CapacityRow style) and no fill, because pegging to
  // max(alloc,guar,des) was producing a misleading "100% full" bar
  // even when the queue has plenty of headroom on the underlying
  // cluster.
  const denom = unbounded ? 1 : capN;
  const allocPct = unbounded ? 0 : clamp01(allocN / denom);
  const guarPct = unbounded ? 0 : guarN > 0 ? clamp01(guarN / denom) : 0;
  const desPct = unbounded ? 0 : desN > 0 ? clamp01(desN / denom) : 0;

  // Colours via antd theme tokens so dark / light mode share the same
  // semantic meaning. Track stays a flat fill (no token equivalent for
  // "muted neutral track" — colorFillSecondary is the closest match).
  const fillColor = overcommit
    ? token.colorError
    : unmetGuarantee
      ? token.colorWarning
      : token.colorPrimary;
  const trackColor = dark ? token.colorFillSecondary : token.colorFillTertiary;
  const guaranteeColor = token.colorSuccess;
  // Deserved tick: brand purple. antd's default token set has no
  // semantic purple, so we keep this one hex literal — it's a "third
  // distinct color" channel, not a state.
  const deservedColor = '#722ed1';

  const niceLabel = humanizeResourceKey(resourceKey, intl);
  const unit = meta.unit ? ` ${meta.unit}` : '';

  return (
    <div>
      <div style={{ marginBottom: 6 }}>
        <Space wrap size="small">
          <Typography.Text strong>{niceLabel}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {intl.formatMessage(
              { id: 'pages.queueQuota.row.alloc' },
              { v: fmt(allocN) },
            )}
            {unit}
          </Typography.Text>
          {guarN > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              ·{' '}
              {intl.formatMessage(
                { id: 'pages.queueQuota.row.guarantee' },
                { v: fmt(guarN) },
              )}
              {unit}
            </Typography.Text>
          )}
          {!unbounded ? (
            <>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                ·{' '}
                {intl.formatMessage(
                  {
                    id: usingClusterCap
                      ? 'pages.queueQuota.row.clusterCap'
                      : 'pages.queueQuota.row.capability',
                  },
                  { v: fmt(capN) },
                )}
                {unit}
              </Typography.Text>
              {usingClusterCap && (
                <Tag color="blue" style={{ fontSize: 11 }}>
                  {intl.formatMessage({
                    id: 'pages.queueQuota.row.clusterCap.tag',
                  })}
                </Tag>
              )}
            </>
          ) : (
            <Tag color="default" style={{ fontSize: 11 }}>
              {intl.formatMessage({ id: 'pages.queueQuota.row.unbounded' })}
            </Tag>
          )}
          {desN > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              ·{' '}
              {intl.formatMessage(
                { id: 'pages.queueQuota.row.deserved' },
                { v: fmt(desN) },
              )}
              {unit}
            </Typography.Text>
          )}
        </Space>
      </div>

      {/* The bar itself — relative parent containing the fill plus
         absolute-positioned tick marks for guarantee and deserved.
         Custom layout because antd Progress doesn't support multi-
         marker overlays. Unbounded case borrows Overview's diagonal-
         stripe track so the empty bar doesn't read as "0% used" — it
         signals "there is no cap to fill" instead. */}
      <div
        style={{
          position: 'relative',
          height: 10,
          background: unbounded
            ? `repeating-linear-gradient(45deg, ${trackColor} 0 6px, transparent 6px 12px)`
            : trackColor,
          borderRadius: 4,
          overflow: 'visible',
        }}
      >
        {/* Allocated fill — hidden in unbounded mode so the striped
           track stays clean and conveys "no ceiling" semantically. */}
        {!unbounded && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: `${allocPct * 100}%`,
              background: fillColor,
              borderRadius: 4,
              transition: 'width 0.4s ease',
            }}
          />
        )}
        {/* Guarantee tick — vertical green line at guarPct. Hide when
           guarantee is 0 to avoid a misleading "0%" marker. */}
        {guarN > 0 && (
          <Tooltip
            title={`${intl.formatMessage({ id: 'pages.queueQuota.row.guarantee' }, { v: fmt(guarN) })}${unit}`}
          >
            <div
              style={{
                position: 'absolute',
                left: `calc(${guarPct * 100}% - 1px)`,
                top: -2,
                bottom: -2,
                width: 2,
                background: guaranteeColor,
                cursor: 'help',
              }}
            />
          </Tooltip>
        )}
        {/* Deserved tick — vertical purple line; only rendered when
           the capacity plugin is active (deserved field populated). */}
        {desN > 0 && (
          <Tooltip
            title={`${intl.formatMessage({ id: 'pages.queueQuota.row.deserved' }, { v: fmt(desN) })}${unit}`}
          >
            <div
              style={{
                position: 'absolute',
                left: `calc(${desPct * 100}% - 1px)`,
                top: -4,
                bottom: -4,
                width: 2,
                background: deservedColor,
                cursor: 'help',
              }}
            />
          </Tooltip>
        )}
      </div>

      {(overcommit || unmetGuarantee) && (
        <Alert
          type={overcommit ? 'error' : 'warning'}
          showIcon
          icon={<AlertOutlined />}
          style={{ marginTop: 8, padding: '4px 12px' }}
          message={
            overcommit
              ? intl.formatMessage(
                  { id: 'pages.queueQuota.row.overcommit' },
                  { allocated: fmt(allocN), capability: fmt(capN) },
                )
              : intl.formatMessage(
                  { id: 'pages.queueQuota.row.unmetGuarantee' },
                  { allocated: fmt(allocN), guarantee: fmt(guarN) },
                )
          }
        />
      )}
    </div>
  );
}

function humanizeResourceKey(
  key: string,
  intl: ReturnType<typeof useIntl>,
): string {
  // Use i18n for the well-known ones, fall back to raw for everything
  // else. The i18n key is escaped (the literal "." in resource names
  // collides with the ICU placeholder syntax for sub-paths).
  const known: Record<string, string> = {
    cpu: 'pages.queueQuota.resource.cpu',
    memory: 'pages.queueQuota.resource.memory',
    'nvidia.com/gpu': 'pages.queueQuota.resource.nvidiaGpu',
    'volcano.sh/vgpu-number': 'pages.queueQuota.resource.vgpuNumber',
    'volcano.sh/vgpu-memory': 'pages.queueQuota.resource.vgpuMemory',
    'volcano.sh/vgpu-cores': 'pages.queueQuota.resource.vgpuCores',
  };
  if (known[key]) return intl.formatMessage({ id: known[key] });
  return key;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0';
  if (v >= 100) return v.toFixed(0);
  if (v >= 1) return v.toFixed(1).replace(/\.0$/, '');
  return v.toPrecision(2);
}

// parseQuantity is shared with OverviewCharts via ./shared/utils so the
// quantity-parsing rules don't drift between Overview and QueueQuota.
