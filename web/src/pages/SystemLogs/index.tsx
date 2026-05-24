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
// antd Tag / Typography subtree for every visible row when only the
// expansion set changed elsewhere. Same pattern Clusters/Logging
// uses for its LogRow — under live-tail polling the rows array
// changes often, but each individual entry's data is immutable.
interface LogRowProps {
  row: SystemLogEntry;
  expanded: boolean;
  onToggleExpand: (seq: number) => void;
}

const LogRow = React.memo(function LogRow({ row, expanded, onToggleExpand }: LogRowProps) {
  const { token } = theme.useToken();
  const hasFields = row.fields && Object.keys(row.fields).length > 0;
  return (
    <div
      onClick={hasFields ? () => onToggleExpand(row.seq) : undefined}
      style={{
        padding: '6px 12px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        cursor: hasFields ? 'pointer' : 'default',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        lineHeight: 1.6,
        background: expanded ? token.colorFillTertiary : undefined,
        // Hover affordance only when the row has fields to expand.
        ...(hasFields ? { transition: 'background 80ms ease' } : null),
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
      {expanded && hasFields && (
        <pre
          style={{
            margin: '8px 0 0 96px',
            padding: 8,
            background: token.colorFillQuaternary,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 4,
            fontSize: 11,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            color: token.colorTextSecondary,
          }}
        >
          {JSON.stringify(row.fields, null, 2)}
        </pre>
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
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // ─── Result state ─────────────────────────────────────────────────
  const [rows, setRows] = useState<SystemLogEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  // Refs the polling timer reads without becoming deps (a render-loop
  // tear-down + recreate would defeat the interval entirely).
  const liveTailRef = useRef(liveTail);
  useEffect(() => {
    liveTailRef.current = liveTail;
  }, [liveTail]);
  const lastSeqRef = useRef<number>(0);

  // ─── Lookups on mount ─────────────────────────────────────────────
  useEffect(() => {
    listSystemNodes()
      .then((arr) => setNodes(arr || []))
      .catch(() => {});
    listSystemLogModules()
      .then((arr) => setModules(arr || []))
      .catch(() => {});
  }, []);

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
      // Track newest seq so an incremental live-tail call picks up
      // strictly newer rows after the user toggles into live mode.
      lastSeqRef.current = arr.length > 0 ? Math.max(...arr.map((r) => r.seq)) : 0;
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
          afterSeq: lastSeqRef.current,
          level: level || undefined,
          module: moduleFilter || undefined,
          q: q || undefined,
          limit: 500,
        });
        const arr = data || [];
        if (arr.length === 0) return;
        // Backend returns DESC; our local array is also DESC (newest
        // first). Prepend new rows + dedupe defensively in case
        // poller windows overlap.
        setRows((prev) => {
          const known = new Set(prev.map((r) => r.seq));
          const fresh = arr.filter((r) => !known.has(r.seq));
          if (fresh.length === 0) return prev;
          const merged = [...fresh, ...prev];
          return merged.length > MAX_ROWS ? merged.slice(0, MAX_ROWS) : merged;
        });
        lastSeqRef.current = Math.max(lastSeqRef.current, ...arr.map((r) => r.seq));
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

  const toggleExpanded = useCallback((seq: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }, []);

  const clearRows = () => {
    setRows([]);
    setExpanded(new Set());
    lastSeqRef.current = 0;
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
              itemContent={(_i, row) => (
                <LogRow
                  row={row}
                  expanded={expanded.has(row.seq)}
                  onToggleExpand={toggleExpanded}
                />
              )}
            />
          )}
        </Card>
      </div>
    </PageContainer>
  );
}
