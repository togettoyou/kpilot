import { useIntl } from '@umijs/max';
import { PageContainer } from '@ant-design/pro-components';
import {
  Button,
  Card,
  Dropdown,
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
import {
  ClearOutlined,
  DownloadOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
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


// 2 s polling matches the existing /clusters/:id/logging Live tail
// cadence, and is well below the 5 s LogsPoller server-side interval
// so the UI catches up within one tick of new persisted rows.
const LIVE_POLL_INTERVAL_MS = 2000;

// LIMIT_OPTIONS drive the toolbar picker. Each value is both the
// backend ?limit= passed on range fetches AND the in-memory cap
// for live-tail accumulation (older rows fall off the top when
// new ones prepend past the picked size). 10000 is the backend's
// hard ceiling — picking more would be silently clamped.
const LIMIT_OPTIONS = [100, 1000, 5000, 10000] as const;

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
      {/* baseline alignment so the tag text + message text sit on
          the same typographic line. Default `start` top-aligns the
          element BOXES — and tags have internal padding that pushes
          their text down, so the bare message span ends up visually
          higher than the tag text. baseline is what makes "TIME
          LEVEL MODULE  message text" read as one row. */}
      <Space size={8} align="baseline" style={{ width: '100%' }}>
        {/* Plain span (not <Typography.Text>) so it inherits the
            parent div's monospace fontFamily. Typography.Text would
            override it back to antd's default sans-serif → digits
            are no longer equal-width and "20:41:17.844" renders a
            hair narrower than "20:41:09.478", making the column
            look ragged. Width pinned to 12ch (= "HH:MM:SS.mmm")
            so every row's level tag starts at the exact same x. */}
        <span
          style={{
            width: '12ch',
            flex: '0 0 auto',
            whiteSpace: 'nowrap',
            color: token.colorTextSecondary,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatAt(row.at)}
        </span>
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
  const [limit, setLimit] = useState<number>(100);
  const [fullscreen, setFullscreen] = useState<boolean>(false);

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
        limit,
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
  }, [nodeID, range, level, moduleFilter, q, limit]);

  // Refetch whenever the node / filters / range / limit change.
  // Live-tail OFF — the polling effect below handles its own fetching.
  useEffect(() => {
    if (liveTail) return;
    runRangeQuery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeID, range, level, moduleFilter, q, limit]);

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
          // Trim oldest rows past the picked limit. (Live-tail size
          // matches the static-query size so toggling between modes
          // doesn't show different volumes.)
          return merged.length > limit ? merged.slice(0, limit) : merged;
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
  }, [liveTail, nodeID, level, moduleFilter, q, limit]);

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

  // Restore every toolbar control to its initial state — useful when
  // the operator has drilled into a specific filter and wants to
  // bail back to "everything, default node, last hour" in one click
  // instead of resetting each control individually. Clearing rows
  // alongside avoids a stale view while the new (post-reset) query
  // is in flight. Fullscreen flag intentionally NOT reset so a user
  // in fullscreen reading mode can hit Reset without losing the
  // immersive view.
  const resetForm = () => {
    setNodeID('server');
    setLevel('');
    setModuleFilter('');
    setQ('');
    setRange({ mode: 'preset', preset: '1h' });
    setLiveTail(false);
    setLimit(100);
    setRows([]);
    lastSeqRef.current = '';
  };

  // Esc exits fullscreen — global keydown listener while fullscreen
  // is active. Skip when the user is in an input/textarea so Esc
  // there still does its normal thing (blur / close picker).
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  // ─── Export current rows ──────────────────────────────────────────
  //
  // Frontend-only: builds the file from the in-memory `rows`, no
  // backend round-trip. The user already sees exactly these rows in
  // the virtuoso list, so a "download" hits the same content they're
  // looking at — no surprise empty exports because a filter trimmed
  // server-side after the page was rendered.
  //
  // TXT: one human-readable line per entry, columns ordered to match
  //      the on-screen layout (time level module msg fields).
  // NDJSON: one full Entry per line, easy to grep / pipe through jq.
  const downloadBlob = useCallback(
    (mime: string, body: string, ext: string) => {
      const blob = new Blob([body], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date()
        .toISOString()
        .replace(/[:T]/g, '-')
        .replace(/\..+$/, '');
      a.href = url;
      a.download = `kpilot-logs-${nodeID}-${ts}.${ext}`;
      a.click();
      // Defer revoke so the browser has a chance to dereference the
      // blob URL into the download. revokeObjectURL is safe to call
      // even if the download already finished.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    [nodeID],
  );

  const downloadTxt = useCallback(() => {
    // Chronological (oldest first) reads more naturally as a file.
    // rows is newest-first, so reverse.
    const lines = rows
      .slice()
      .reverse()
      .map((r) => {
        const fields = r.fields
          ? Object.entries(r.fields)
              .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
              .join(' ')
          : '';
        const module = r.module ? ` ${r.module}` : '';
        return `${r.at} ${r.level.toUpperCase().padEnd(5)}${module} ${r.msg}${fields ? '  ' + fields : ''}`;
      })
      .join('\n');
    downloadBlob('text/plain;charset=utf-8', lines + '\n', 'txt');
  }, [rows, downloadBlob]);

  const downloadNdjson = useCallback(() => {
    const lines = rows
      .slice()
      .reverse()
      .map((r) => JSON.stringify(r))
      .join('\n');
    downloadBlob('application/x-ndjson;charset=utf-8', lines + '\n', 'jsonl');
  }, [rows, downloadBlob]);

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
        {/* ─── Toolbar card (hidden in fullscreen mode) ─── */}
        {!fullscreen && (
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
              <Button size="small" onClick={resetForm}>
                {intl.formatMessage({ id: 'pages.system.logs.toolbar.reset' })}
              </Button>
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
              {/* Result-size picker. Drives both the backend ?limit= AND
                  the live-tail in-memory cap, so toggling between modes
                  doesn't change how many rows the operator sees. */}
              <Select
                value={limit}
                onChange={setLimit}
                options={LIMIT_OPTIONS.map((n) => ({
                  value: n,
                  label: `${intl.formatMessage({ id: 'pages.system.logs.toolbar.limit' })} ${n}`,
                }))}
                style={{ width: 110 }}
                size="small"
              />
              <Tooltip
                title={intl.formatMessage({ id: 'pages.system.logs.tooltip.liveTail' })}
              >
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
            </Space>
          </Card>
        )}

        {/* ─── Result card — fills remaining height, internal scroll only.
            Mirrors /clusters/:id/logging: title carries the result count,
            extra hosts Download + Fullscreen toggle. */}
        <Card
          size="small"
          title={
            <Space size={8}>
              <Typography.Text strong>
                {intl.formatMessage({ id: 'pages.system.logs.results.title' })}
              </Typography.Text>
              {rows.length > 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {intl.formatMessage(
                    {
                      id:
                        rows.length === limit
                          ? 'pages.system.logs.status.countTrimmed'
                          : 'pages.system.logs.status.count',
                    },
                    { count: rows.length },
                  )}
                </Typography.Text>
              )}
            </Space>
          }
          extra={
            <Space size={4}>
              <Dropdown
                disabled={rows.length === 0}
                menu={{
                  items: [
                    {
                      key: 'txt',
                      label: intl.formatMessage({ id: 'pages.system.logs.download.txt' }),
                      onClick: downloadTxt,
                    },
                    {
                      key: 'ndjson',
                      label: intl.formatMessage({
                        id: 'pages.system.logs.download.ndjson',
                      }),
                      onClick: downloadNdjson,
                    },
                  ],
                }}
              >
                <Button
                  size="small"
                  type="text"
                  icon={<DownloadOutlined />}
                  disabled={rows.length === 0}
                >
                  {intl.formatMessage({ id: 'pages.system.logs.toolbar.download' })}
                </Button>
              </Dropdown>
              <Tooltip
                title={intl.formatMessage({
                  id: fullscreen
                    ? 'pages.system.logs.fullscreen.exit'
                    : 'pages.system.logs.fullscreen.enter',
                })}
              >
                <Button
                  size="small"
                  type="text"
                  icon={
                    fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />
                  }
                  onClick={() => setFullscreen((v) => !v)}
                />
              </Tooltip>
            </Space>
          }
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
