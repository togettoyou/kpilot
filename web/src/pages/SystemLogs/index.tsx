import { useIntl } from '@umijs/max';
import { PageContainer } from '@ant-design/pro-components';
import {
  Button,
  Card,
  Empty,
  Input,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { ClearOutlined, ReloadOutlined } from '@ant-design/icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import TimeRangePicker, {
  buildRangeQuery,
  type TimeRangeValue,
} from '@/components/TimeRangePicker';
import {
  listSystemLogModules,
  listSystemLogs,
  listSystemNodes,
  type SystemLogEntry,
  type SystemNode,
} from '@/services/kpilot/system';

const { Text } = Typography;

// 2 s polling matches the existing /clusters/:id/logging Live tail
// cadence, and is well below the 5 s LogsPoller server-side interval
// so the UI catches up within one tick of new persisted rows.
const LIVE_POLL_INTERVAL_MS = 2000;

// Cap rows kept in memory. Beyond this we drop oldest so a stuck
// live-tail session doesn't blow up the browser. 5 000 rows ×
// ~300 B ≈ 1.5 MB; virtuoso keeps the rendered DOM small regardless
// of the underlying array size.
const MAX_ROWS = 5000;

// Level filter dropdown options. Severity-ordered top-down — clearer
// for an operator skimming "show me only the loud stuff" → "show me
// everything". Sticking to enum values matches the backend's
// `level >= ?` semantics.
const LEVEL_OPTIONS: { value: string; messageId: string }[] = [
  { value: '', messageId: 'pages.system.logs.level.all' },
  { value: 'error', messageId: 'pages.system.logs.level.errorPlus' },
  { value: 'warn', messageId: 'pages.system.logs.level.warnPlus' },
  { value: 'info', messageId: 'pages.system.logs.level.infoPlus' },
  { value: 'debug', messageId: 'pages.system.logs.level.debugPlus' },
];

// Tag color per level — sits next to each row. The mapping matches
// the severity bands used elsewhere (Compute usageColor).
function levelColor(level: string): string {
  switch (level) {
    case 'error':
    case 'fatal':
      return 'red';
    case 'warn':
      return 'orange';
    case 'info':
      return 'blue';
    case 'debug':
      return 'default';
    default:
      return 'default';
  }
}

// HH:MM:SS.mmm — log views want time-of-day with millisecond
// resolution for ordering. Date part is in the row's `at` if anyone
// needs it (e.g. cross-day ranges); cluttering every row with
// YYYY-MM-DD is wasted column width.
function formatAt(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// ─── LogRow ────────────────────────────────────────────────────────
//
// Memoized so Virtuoso's itemContent re-renders don't walk the
// antd Tag / Typography subtree for every visible row when the rows
// array changes (live-tail prepends new entries every 2 s, but each
// individual entry's data is immutable — memo lets React skip the
// reconcile for non-tail rows).
interface LogRowProps {
  row: SystemLogEntry;
}

// formatFieldValue renders one structured field's value as a single
// inline token. Scalars (string / number / bool / null) get their
// natural toString; objects + arrays fall back to compact JSON so
// nested shapes still show without ballooning into multi-line blocks.
function formatFieldValue(v: unknown): string {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return String(v);
  // Object / array — compact JSON keeps it on one segment.
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const LogRow = React.memo(function LogRow({ row }: LogRowProps) {
  const { token } = theme.useToken();
  const fieldEntries =
    row.fields && Object.keys(row.fields).length > 0
      ? Object.entries(row.fields)
      : null;
  return (
    <div
      style={{
        padding: '4px 12px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        lineHeight: 1.55,
      }}
    >
      <Space size={8} align="start" style={{ width: '100%' }}>
        <Text type="secondary" style={{ minWidth: 88, whiteSpace: 'nowrap' }}>
          {formatAt(row.at)}
        </Text>
        <Tag
          color={levelColor(row.level)}
          style={{ minWidth: 56, textAlign: 'center', margin: 0 }}
        >
          {row.level.toUpperCase()}
        </Tag>
        {row.module && (
          <Tag color="default" style={{ margin: 0 }}>
            {row.module}
          </Tag>
        )}
        <span style={{ flex: 1, wordBreak: 'break-word', color: token.colorText }}>
          {row.msg}
        </span>
      </Space>
      {fieldEntries && (
        // Inline KV under the message — same indent as the message
        // column (88 + tag widths ≈ 96px) so fields visually attach
        // to the line they came from. flex-wrap lets long field sets
        // break across multiple lines without horizontal scrolling.
        <div
          style={{
            marginLeft: 96,
            marginTop: 2,
            display: 'flex',
            flexWrap: 'wrap',
            columnGap: 12,
            rowGap: 2,
            fontSize: 11,
            color: token.colorTextTertiary,
          }}
        >
          {fieldEntries.map(([k, v]) => (
            <span key={k}>
              <span style={{ color: token.colorTextSecondary }}>{k}</span>=
              <span style={{ color: token.colorText, wordBreak: 'break-all' }}>
                {formatFieldValue(v)}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
});

export default function SystemLogsPage() {
  const intl = useIntl();
  const { token } = theme.useToken();

  // ─── Lookups (nodes + modules) ────────────────────────────────────
  const [nodes, setNodes] = useState<SystemNode[]>([]);
  const [modules, setModules] = useState<string[]>([]);

  // ─── Query controls ───────────────────────────────────────────────
  const [nodeID, setNodeID] = useState<string>('server');
  const [level, setLevel] = useState<string>('');
  const [moduleFilter, setModuleFilter] = useState<string>('');
  const [q, setQ] = useState<string>('');
  const [range, setRange] = useState<TimeRangeValue>({ mode: 'preset', preset: '1h' });
  const [liveTail, setLiveTail] = useState<boolean>(false);

  // ─── Result state ─────────────────────────────────────────────────
  const [rows, setRows] = useState<SystemLogEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  // Refs the polling timer reads without becoming deps (a render-loop
  // tear-down + recreate would defeat the interval entirely).
  const liveTailRef = useRef(liveTail);
  useEffect(() => {
    liveTailRef.current = liveTail;
  }, [liveTail]);
  // Decimal string, NOT number. seq is uint64 anchored at UnixNano
  // (~1.8e18) — exceeds 2^53, so Number would lose precision and the
  // cursor would silently desync. Empty string is the "no cursor yet"
  // sentinel; the backend treats after_seq=0 as "no filter" anyway,
  // so both work for the initial fetch.
  const lastSeqRef = useRef<string>('');

  // ─── Lookups ──────────────────────────────────────────────────────
  // Nodes are static for the session — fetch once.
  useEffect(() => {
    listSystemNodes()
      .then((arr) => setNodes(arr || []))
      .catch(() => {});
  }, []);

  // Modules are per-node: server-side router/gorm/handler.* don't
  // belong in a worker picker (and tunnel/http-proxy don't belong
  // in the server picker). Re-fetch whenever the user switches
  // node, and clear any picked module that isn't valid in the new
  // node's list to keep the filter coherent.
  useEffect(() => {
    listSystemLogModules(nodeID)
      .then((arr) => {
        const mods = arr || [];
        setModules(mods);
        setModuleFilter((cur) => (cur && !mods.includes(cur) ? '' : cur));
      })
      .catch(() => {});
  }, [nodeID]);

  // ─── Range-mode query ─────────────────────────────────────────────
  const runRangeQuery = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listSystemLogs(nodeID, {
        rangeQuery: buildRangeQuery(range),
        level: level || undefined,
        module: moduleFilter || undefined,
        q: q || undefined,
        limit: MAX_ROWS,
      });
      const arr = data || [];
      setRows(arr);
      // Track newest seq for the live-tail cursor. BigInt compare
      // because seq strings are 19-digit uint64 — Number.MAX_SAFE_INTEGER
      // can't hold them. The backend returns rows newest-first so the
      // first one IS the max, no full scan needed.
      lastSeqRef.current = arr.length > 0 ? arr[0].seq : '';
    } finally {
      setLoading(false);
    }
  }, [nodeID, range, level, moduleFilter, q]);

  // Refetch whenever the node / filters / range change. Live-tail OFF
  // — the polling effect below handles its own fetching.
  useEffect(() => {
    if (liveTail) return;
    runRangeQuery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeID, range, level, moduleFilter, q]);

  // ─── Live tail polling ────────────────────────────────────────────
  useEffect(() => {
    if (!liveTail) return;
    // Seed: if we have no rows yet, fire a range-mode pull so the
    // panel doesn't sit empty for the first 2 s tick.
    if (rows.length === 0) {
      runRangeQuery();
    }
    const t = window.setInterval(async () => {
      if (!liveTailRef.current) return;
      try {
        const data = await listSystemLogs(nodeID, {
          // empty string == no cursor: backend treats missing/0
          // after_seq as "no filter", returns the newest batch.
          afterSeq: lastSeqRef.current || undefined,
          level: level || undefined,
          module: moduleFilter || undefined,
          q: q || undefined,
          limit: 500,
        });
        const arr = data || [];
        if (arr.length === 0) return;
        // Backend returns DESC; our local array is also DESC (newest
        // first). Prepend new rows + dedupe defensively in case
        // poller windows overlap. Set<string> works correctly with
        // BigInt-sized seqs (vs Set<number> which would collapse
        // seqs differing by < ~1µs onto the same key).
        setRows((prev) => {
          const known = new Set(prev.map((r) => r.seq));
          const fresh = arr.filter((r) => !known.has(r.seq));
          if (fresh.length === 0) return prev;
          const merged = [...fresh, ...prev];
          return merged.length > MAX_ROWS ? merged.slice(0, MAX_ROWS) : merged;
        });
        // arr is newest-first → first row is the new max. Compare via
        // BigInt to safely handle the 19-digit values.
        const newest = arr[0].seq;
        if (lastSeqRef.current === '' || BigInt(newest) > BigInt(lastSeqRef.current)) {
          lastSeqRef.current = newest;
        }
      } catch {
        // Network blip — next tick retries.
      }
    }, LIVE_POLL_INTERVAL_MS);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTail, nodeID, level, moduleFilter, q]);

  // ─── Full-bleed layout: wrapper consumes viewport-top-footer-gap ──
  //
  // Mirrors Clusters/Logging's closed-form measurement so the page
  // never produces a browser-level scrollbar. Walks up resetting
  // ancestor scrollTops on mount (Umi keeps content-area scroll on
  // navigation) so getBoundingClientRect().top is meaningful.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [containerHeight, setContainerHeight] = useState<number | null>(null);

  useEffect(() => {
    window.scrollTo(0, 0);
    let el: HTMLElement | null = wrapperRef.current;
    if (!el) {
      requestAnimationFrame(() => {
        let inner: HTMLElement | null = wrapperRef.current;
        while (inner && inner !== document.body) {
          if (inner.scrollTop) inner.scrollTop = 0;
          inner = inner.parentElement;
        }
      });
      return;
    }
    while (el && el !== document.body) {
      if (el.scrollTop) el.scrollTop = 0;
      el = el.parentElement;
    }
  }, []);

  useEffect(() => {
    let pending = 0;
    const measure = () => {
      pending = 0;
      const el = wrapperRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const footer = document.querySelector<HTMLElement>('.kpilot-footer');
      if (!footer) {
        const h = Math.max(0, Math.floor(window.innerHeight - rect.top));
        setContainerHeight((prev) => (prev === h ? prev : h));
        return;
      }
      const footerRect = footer.getBoundingClientRect();
      const gap = footerRect.top - rect.bottom;
      const h = Math.max(
        0,
        Math.floor(window.innerHeight - rect.top - footerRect.height - gap),
      );
      setContainerHeight((prev) => (prev === h ? prev : h));
    };
    const schedule = () => {
      if (pending) return;
      pending = requestAnimationFrame(measure);
    };
    schedule();
    window.addEventListener('resize', schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(document.body);
    return () => {
      if (pending) cancelAnimationFrame(pending);
      window.removeEventListener('resize', schedule);
      ro.disconnect();
    };
  }, []);

  // ─── Derived UI ───────────────────────────────────────────────────
  const nodeOptions = useMemo(
    () =>
      nodes.map((n) => ({
        value: n.node_id,
        label:
          n.kind === 'server'
            ? intl.formatMessage({ id: 'pages.system.logs.node.server' })
            : intl.formatMessage({ id: 'pages.system.logs.node.workerPrefix' }) +
              (n.cluster_name || n.node_id) +
              (!n.online ? intl.formatMessage({ id: 'pages.system.logs.node.offlineSuffix' }) : ''),
      })),
    [nodes, intl],
  );

  const levelOptions = useMemo(
    () =>
      LEVEL_OPTIONS.map((o) => ({
        value: o.value,
        label: intl.formatMessage({ id: o.messageId }),
      })),
    [intl],
  );

  const moduleOptions = useMemo(
    () => [
      { value: '', label: intl.formatMessage({ id: 'pages.system.logs.module.all' }) },
      ...modules.map((m) => ({
        value: m,
        label: m || intl.formatMessage({ id: 'pages.system.logs.module.empty' }),
      })),
    ],
    [modules, intl],
  );

  const clearRows = () => {
    setRows([]);
    lastSeqRef.current = '';
  };

  // ─── Render ───────────────────────────────────────────────────────
  return (
    <PageContainer
      header={{
        title: intl.formatMessage({ id: 'pages.system.logs.title' }),
        breadcrumb: {},
      }}
      // ProLayout has its own padding around children; we still want
      // the page to feel "full-bleed" within the content area but
      // PageContainer's own internal padding is fine here.
    >
      <div
        ref={wrapperRef}
        style={{
          // Closed-form height (viewport - top - footer - gap). Falls
          // back to a sensible default before ResizeObserver fires.
          height: containerHeight != null ? containerHeight : 'calc(100vh - 220px)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {/* ─── Toolbar card ─── */}
        <Card
          size="small"
          styles={{ body: { padding: '10px 12px' } }}
          style={{ flex: '0 0 auto' }}
        >
          <Space size={8} wrap>
            <Select
              value={nodeID}
              onChange={setNodeID}
              options={nodeOptions}
              style={{ minWidth: 220 }}
              size="small"
              placeholder={intl.formatMessage({
                id: 'pages.system.logs.toolbar.nodePlaceholder',
              })}
            />
            <Select
              value={level}
              onChange={setLevel}
              options={levelOptions}
              style={{ width: 150 }}
              size="small"
            />
            <Select
              value={moduleFilter}
              onChange={setModuleFilter}
              options={moduleOptions}
              style={{ minWidth: 180 }}
              size="small"
              showSearch
              optionFilterProp="label"
              allowClear
              onClear={() => setModuleFilter('')}
              placeholder={intl.formatMessage({
                id: 'pages.system.logs.toolbar.modulePlaceholder',
              })}
            />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onPressEnter={() => runRangeQuery()}
              style={{ width: 240 }}
              size="small"
              allowClear
              placeholder={intl.formatMessage({ id: 'pages.system.logs.toolbar.search' })}
            />
            {/* Range picker only meaningful in static-query mode.
                Hidden in live tail so operators don't think the range
                still constrains the polling tick. */}
            {!liveTail && (
              <TimeRangePicker
                value={range}
                onChange={setRange}
                presets={['1h', '3h', '6h', '12h', '24h']}
              />
            )}
            <Tooltip title={intl.formatMessage({ id: 'pages.system.logs.tooltip.liveTail' })}>
              <Space size={6} align="center">
                <Switch checked={liveTail} onChange={setLiveTail} size="small" />
                <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
                  {intl.formatMessage({ id: 'pages.system.logs.toolbar.liveTail' })}
                </span>
              </Space>
            </Tooltip>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => runRangeQuery()}
              loading={loading}
              disabled={liveTail}
            >
              {intl.formatMessage({ id: 'pages.system.logs.toolbar.refresh' })}
            </Button>
            <Button
              size="small"
              icon={<ClearOutlined />}
              onClick={clearRows}
              disabled={rows.length === 0}
            >
              {intl.formatMessage({ id: 'pages.system.logs.toolbar.clear' })}
            </Button>
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 12,
                color: token.colorTextTertiary,
              }}
            >
              {rows.length > 0 &&
                intl.formatMessage(
                  {
                    id:
                      rows.length === MAX_ROWS
                        ? 'pages.system.logs.status.countTrimmed'
                        : 'pages.system.logs.status.count',
                  },
                  { count: rows.length },
                )}
            </span>
          </Space>
        </Card>

        {/* ─── Result card — fills remaining height, internal scroll only ─── */}
        <Card
          size="small"
          styles={{
            body: {
              padding: 0,
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            },
          }}
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {rows.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={intl.formatMessage({
                  id: loading
                    ? 'pages.system.logs.empty.loading'
                    : liveTail
                    ? 'pages.system.logs.empty.liveWaiting'
                    : 'pages.system.logs.empty.noMatch',
                })}
              />
            </div>
          ) : (
            <Virtuoso<SystemLogEntry>
              style={{ flex: 1, minHeight: 0 }}
              data={rows}
              itemContent={(_i, row) => <LogRow row={row} />}
            />
          )}
        </Card>
      </div>
    </PageContainer>
  );
}
