import {
  AlertOutlined,
  AppstoreOutlined,
  BranchesOutlined,
  CrownOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { useIntl, useParams, useRequest } from '@umijs/max';
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
} from 'antd';
import { useThemeMode } from 'antd-style';
import React, { useMemo, useState } from 'react';

import {
  listVolcanoQueues,
  type QueueRow,
} from '@/services/kpilot/volcano-list';

import {
  NotInstalled,
  RefreshControl,
  isResourceNotAvailable,
  useAutoRefresh,
} from './shared/Layout';

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

  const { data, loading, error, refresh } = useRequest(
    () => listVolcanoQueues(clusterId, { limit: 500 }),
    {
      formatResult: (res) => res,
      refreshDeps: [clusterId],
      ready: !!clusterId,
    },
  );

  // Polling is opt-in; useAutoRefresh starts at 0 (off) and the
  // RefreshControl dropdown lets the user pick a cadence.
  const [interval, setInter] = useAutoRefresh(refresh, !!data);

  if (error && isResourceNotAvailable(error)) {
    return (
      <PageContainer ghost>
        <NotInstalled clusterId={clusterId} />
      </PageContainer>
    );
  }

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
      const kids = (childrenOf.get(q.name) ?? []).slice().sort((a, b) =>
        a.name.localeCompare(b.name),
      );
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
    ? (childrenOf.get(selectedQueue) ?? []).slice().sort((a, b) =>
        a.name.localeCompare(b.name),
      )
    : [];

  return (
    <PageContainer
      ghost
      header={{
        title: intl.formatMessage({ id: 'pages.queueQuota.title' }),
        extra: (
          <Space>
            <RefreshControl
              interval={interval}
              setInterval={setInter}
              loading={loading}
              refresh={refresh}
            />
          </Space>
        ),
      }}
    >
      <Spin spinning={loading && !data}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {/* Top filter row — Queue selector with the indented tree
             option list so parent / child relationships are obvious
             without leaving the select. */}
          <Card size="small">
            <Space wrap>
              <span>
                {intl.formatMessage({ id: 'pages.queueQuota.selector.label' })}
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
              <QueueDetailCard queue={selected} dark={dark} primary />
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
                  <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                    {selectedChildren.map((c) => (
                      <QueueDetailCard
                        key={c.name}
                        queue={c}
                        dark={dark}
                        primary={false}
                      />
                    ))}
                  </Space>
                </Card>
              )}
            </>
          )}
        </Space>
      </Spin>
    </PageContainer>
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
}: {
  queue: QueueRow;
  dark: boolean;
  primary: boolean;
}) {
  const intl = useIntl();

  const resources = useMemo(() => {
    const keys = new Set<string>();
    [queue.capability, queue.guarantee, queue.allocated, queue.deserved].forEach(
      (m) => {
        if (m) for (const k of Object.keys(m)) keys.add(k);
      },
    );
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
              {intl.formatMessage({ id: 'pages.queueQuota.card.nonReclaimable' })}
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
  dark,
}: {
  resourceKey: string;
  capability?: string;
  guarantee?: string;
  allocated?: string;
  deserved?: string;
  dark: boolean;
}) {
  const intl = useIntl();
  const meta = resourceMeta(resourceKey);

  const allocN = parseQuantity(allocated) * meta.scale;
  const capN = parseQuantity(capability) * meta.scale;
  const guarN = parseQuantity(guarantee) * meta.scale;
  const desN = parseQuantity(deserved) * meta.scale;

  const unbounded = capN <= 0;
  const overcommit = !unbounded && allocN > capN;
  const unmetGuarantee = guarN > 0 && allocN < guarN;

  // Percentages — pegged to capability when bounded; clamped to [0,1].
  const denom = unbounded ? Math.max(allocN, guarN, desN, 1) : capN;
  const allocPct = clamp01(allocN / denom);
  const guarPct = guarN > 0 ? clamp01(guarN / denom) : 0;
  const desPct = desN > 0 ? clamp01(desN / denom) : 0;

  // Colours: alloc bar tinted red on overcommit / orange on unmet
  // guarantee, otherwise primary blue.
  const fillColor = overcommit
    ? '#ff4d4f'
    : unmetGuarantee
      ? '#fa8c16'
      : '#1677ff';
  const trackColor = dark ? '#1f1f1f' : '#f0f0f0';
  const guaranteeColor = '#52c41a';
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
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              ·{' '}
              {intl.formatMessage(
                { id: 'pages.queueQuota.row.capability' },
                { v: fmt(capN) },
              )}
              {unit}
            </Typography.Text>
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
         marker overlays. */}
      <div
        style={{
          position: 'relative',
          height: 10,
          background: trackColor,
          borderRadius: 4,
          overflow: 'visible',
        }}
      >
        {/* Allocated fill */}
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

// Inline copy of the K8s Quantity parser from OverviewCharts.tsx. The
// function is small / pure and stays close to the only other call site,
// so duplicating it here avoids a shared-utils file just for one
// function. Refactor to common if a third call site appears.
function parseQuantity(raw: string | undefined): number {
  if (!raw) return 0;
  const s = raw.trim();
  if (!s) return 0;
  if (s.endsWith('m')) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n / 1000 : 0;
  }
  const binPrefixes: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
  };
  for (const [p, mul] of Object.entries(binPrefixes)) {
    if (s.endsWith(p)) {
      const n = Number(s.slice(0, -p.length));
      return Number.isFinite(n) ? n * mul : 0;
    }
  }
  const decPrefixes: Record<string, number> = {
    K: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
    P: 1000 ** 5,
  };
  for (const [p, mul] of Object.entries(decPrefixes)) {
    if (s.endsWith(p)) {
      const n = Number(s.slice(0, -p.length));
      return Number.isFinite(n) ? n * mul : 0;
    }
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
