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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

// 2 s polling matches the existing Clusters/Logging page's Live tail
// cadence, and is well below the 5 s LogsPoller interval so the UI
// catches up within one tick of new persisted rows. Polling stops
// when the toggle is off — no background work for static range
// queries.
const LIVE_POLL_INTERVAL_MS = 2000;

// Max rows we keep in memory. Beyond this we trim oldest so a stuck
// live-tail session doesn't blow up the browser. 5 000 lines × ~300 B
// per row ≈ 1.5 MB, comfortably below any practical limit; virtuoso
// keeps the rendered DOM tiny regardless of the underlying array size.
const MAX_ROWS = 5000;

// Level filter dropdown options. Severity-ordered so the picker reads
// top-down as "less noisy → more noisy" (debug at the bottom).
const LEVEL_OPTIONS = [
  { value: '', label: '所有等级' },
  { value: 'error', label: 'Error+' },
  { value: 'warn', label: 'Warn+' },
  { value: 'info', label: 'Info+' },
  { value: 'debug', label: 'Debug+' },
];

// Color mapping for the level tag — matches the level severity bands
// used elsewhere in the UI (Compute usageColor + Grafana defaults).
function levelColor(level: string): string | undefined {
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
      return undefined;
  }
}

function formatAt(at: string): string {
  // Browser-local time, second precision is enough for log grepping;
  // ms is in the raw row for the expanded view.
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function SystemLogsPage() {
  const intl = useIntl();
  const { token } = theme.useToken();

  // ─── Static lookups (nodes + modules) ─────────────────────────────
  const [nodes, setNodes] = useState<SystemNode[]>([]);
  const [modules, setModules] = useState<string[]>([]);

  // ─── Query controls ────────────────────────────────────────────────
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

  // Refs that the polling timer + Run handler need without becoming
  // useEffect deps (otherwise the interval would be torn down and
  // recreated on every state tick).
  const liveTailRef = useRef(liveTail);
  useEffect(() => {
    liveTailRef.current = liveTail;
  }, [liveTail]);
  const lastSeqRef = useRef<number>(0);

  // ─── Node + module lookups (once on mount) ─────────────────────────
  useEffect(() => {
    listSystemNodes()
      .then((arr) => setNodes(arr || []))
      .catch(() => {});
    listSystemLogModules()
      .then((arr) => setModules(arr || []))
      .catch(() => {});
  }, []);

  // ─── Range-mode query (full re-fetch) ──────────────────────────────
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
      // Track newest seq so the live-tail incremental call picks up
      // strictly newer rows when enabled.
      lastSeqRef.current = arr.length > 0 ? Math.max(...arr.map((r) => r.seq)) : 0;
    } finally {
      setLoading(false);
    }
  }, [nodeID, range, level, moduleFilter, q]);

  // Refetch whenever the node / filters / range change. Live-tail OFF.
  useEffect(() => {
    if (liveTail) return; // Tail mode handles fetching on its own.
    runRangeQuery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeID, range, level, moduleFilter, q]);

  // ─── Live tail polling ─────────────────────────────────────────────
  useEffect(() => {
    if (!liveTail) return;
    // Seed: if we don't have any rows yet, do a range-mode pull so
    // the operator immediately sees the most recent slice. Without
    // this the panel stays empty until the first 2 s tick.
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
        // first). Splice the new rows in at the top, then trim to
        // MAX_ROWS so we don't grow unbounded.
        setRows((prev) => {
          // Defensive seq de-dup in case the poller window overlapped.
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

  // ─── Derived UI bits ───────────────────────────────────────────────
  const nodeOptions = useMemo(
    () =>
      nodes.map((n) => ({
        value: n.node_id,
        label:
          n.kind === 'server'
            ? `Server (control-plane)`
            : `Worker · ${n.cluster_name || n.node_id}${n.online ? '' : ' (离线)'}`,
        disabled: !n.diag_available && n.online,
      })),
    [nodes],
  );

  const moduleOptions = useMemo(
    () => [
      { value: '', label: '所有模块' },
      ...modules.map((m) => ({ value: m, label: m || '(无模块)' })),
    ],
    [modules],
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

  // ─── Render a single row ───────────────────────────────────────────
  const renderRow = useCallback(
    (_index: number, row: SystemLogEntry) => {
      const isOpen = expanded.has(row.seq);
      const hasFields = row.fields && Object.keys(row.fields).length > 0;
      return (
        <div
          onClick={() => toggleExpanded(row.seq)}
          style={{
            padding: '6px 12px',
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            cursor: hasFields ? 'pointer' : 'default',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 12,
            lineHeight: 1.5,
            background: isOpen ? token.colorFillTertiary : undefined,
          }}
        >
          <Space size={8} style={{ width: '100%' }} align="start">
            <Text type="secondary" style={{ minWidth: 150, whiteSpace: 'nowrap' }}>
              {formatAt(row.at)}
            </Text>
            <Tag color={levelColor(row.level)} style={{ minWidth: 48, textAlign: 'center', margin: 0 }}>
              {row.level.toUpperCase()}
            </Tag>
            {row.module && (
              <Tag color="default" style={{ margin: 0 }}>
                {row.module}
              </Tag>
            )}
            <span style={{ flex: 1, wordBreak: 'break-word' }}>{row.msg}</span>
          </Space>
          {isOpen && hasFields && (
            <pre
              style={{
                margin: '8px 0 0 158px',
                padding: 8,
                background: token.colorFillQuaternary,
                borderRadius: 4,
                fontSize: 11,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {JSON.stringify(row.fields, null, 2)}
            </pre>
          )}
        </div>
      );
    },
    [expanded, toggleExpanded, token],
  );

  return (
    <PageContainer
      header={{
        title: intl.formatMessage({ id: 'pages.system.logs.title', defaultMessage: '系统日志' }),
        breadcrumb: {},
      }}
    >
      <Card
        styles={{ body: { padding: 12 } }}
        // Filter strip — single row, wraps on narrow screens.
        title={
          <Space size={8} wrap>
            <Select
              value={nodeID}
              onChange={setNodeID}
              options={nodeOptions}
              style={{ minWidth: 220 }}
              size="small"
            />
            <Select
              value={level}
              onChange={setLevel}
              options={LEVEL_OPTIONS}
              style={{ width: 130 }}
              size="small"
            />
            <Select
              value={moduleFilter}
              onChange={setModuleFilter}
              options={moduleOptions}
              style={{ minWidth: 160 }}
              size="small"
              showSearch
              optionFilterProp="label"
              allowClear
              onClear={() => setModuleFilter('')}
            />
            <Input
              placeholder="搜索消息..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onPressEnter={() => runRangeQuery()}
              style={{ width: 220 }}
              size="small"
              allowClear
            />
            {/* Live tail mode hides the picker — only static range
                queries need it. Avoids the visual conflict where the
                operator might think the range is still respected. */}
            {!liveTail && (
              <TimeRangePicker
                value={range}
                onChange={setRange}
                presets={['1h', '3h', '6h', '12h', '24h']}
              />
            )}
            <Tooltip
              title={
                liveTail
                  ? '关闭后可手动指定时间范围查询'
                  : '开启后每 2 秒拉取新行,prepend 到顶部'
              }
            >
              <Space size={4}>
                <Switch checked={liveTail} onChange={setLiveTail} size="small" />
                <span style={{ fontSize: 12 }}>Live Tail</span>
              </Space>
            </Tooltip>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => runRangeQuery()}
              loading={loading}
              disabled={liveTail}
            >
              刷新
            </Button>
            <Button
              size="small"
              icon={<ClearOutlined />}
              onClick={clearRows}
              disabled={rows.length === 0}
            >
              清空
            </Button>
          </Space>
        }
      >
        <div
          style={{
            // Fixed-height viewport for virtuoso. ~75vh keeps the
            // filter strip + footer visible; users on tall screens get
            // more rows automatically, narrow ones still get a usable
            // panel without page-wide scrolling.
            height: 'calc(100vh - 240px)',
            background: token.colorBgContainer,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 4,
          }}
        >
          {rows.length === 0 ? (
            <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
              <Empty
                description={
                  loading
                    ? '加载中...'
                    : liveTail
                    ? '等待新日志...'
                    : '该范围内没有匹配的日志'
                }
              />
            </div>
          ) : (
            <Virtuoso<SystemLogEntry>
              data={rows}
              itemContent={renderRow}
              followOutput={false}
              style={{ height: '100%' }}
            />
          )}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: token.colorTextTertiary }}>
          {rows.length > 0 && (
            <span>
              {rows.length} 条
              {rows.length === MAX_ROWS && ' (已达上限, 旧行已被裁剪)'}
            </span>
          )}
        </div>
      </Card>
    </PageContainer>
  );
}
