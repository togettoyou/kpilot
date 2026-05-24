import { history, useIntl, useParams } from '@umijs/max';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  Button,
  Card,
  Col,
  Modal,
  Row,
  Space,
  Statistic,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  DownloadOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getSystemSnapshot,
  pprofURL,
  systemStreamURL,
  type SystemSnapshot,
} from '@/services/kpilot/system';
import {
  formatBigNumber,
  formatBytes,
  formatDurationSeconds,
  formatMillis,
  formatPercent,
} from '../format';

const SystemChart = React.lazy(() => import('./SystemChart'));
import type { SystemSeries } from './SystemChart';

// Ring buffer is bounded — 1 Hz × 60 min = 3600 entries × ~2 KB JSON ≈ 7 MB
// per tab. Modern browser handles this fine; older devices may want a
// shorter window, but for an ops dashboard the operator wants to
// scroll back at least an hour.
const RING_CAPACITY = 3600;

// Pprof endpoints surfaced as download buttons. The two high-cost
// ones (profile, trace) require ?confirm=true — the page wraps those
// in a Modal before opening the URL.
const PPROF_ITEMS: { kind: string; labelId: string; cost?: 'high'; seconds?: number }[] = [
  { kind: 'heap', labelId: 'system.pprof.heap' },
  { kind: 'goroutine', labelId: 'system.pprof.goroutine' },
  { kind: 'allocs', labelId: 'system.pprof.allocs' },
  { kind: 'block', labelId: 'system.pprof.block' },
  { kind: 'mutex', labelId: 'system.pprof.mutex' },
  { kind: 'threadcreate', labelId: 'system.pprof.threadcreate' },
  { kind: 'profile', labelId: 'system.pprof.profile', cost: 'high', seconds: 30 },
  { kind: 'trace', labelId: 'system.pprof.trace', cost: 'high', seconds: 5 },
];

export default function SystemDetailPage() {
  const intl = useIntl();
  const params = useParams<{ node: string }>();
  const nodeID = params.node || '';

  // Ring buffer + tick — see the file-top comment for the rationale
  // of storing the buffer in a ref and bumping a numeric state to
  // trigger memo recomputation.
  const ringRef = useRef<SystemSnapshot[]>([]);
  const [tick, setTick] = useState(0);
  const [latest, setLatest] = useState<SystemSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  // paused = operator clicked Pause. When true: the WS effect skips
  // setup (so no socket open → server-side hub unsub fires → if
  // we were the last subscriber, the per-node ticker goroutine
  // stops). Toggle back to false re-opens the socket. Ring buffer
  // is preserved across the pause so existing chart history stays
  // on screen.
  const [paused, setPaused] = useState(false);

  const push = useCallback((snap: SystemSnapshot) => {
    const ring = ringRef.current;
    ring.push(snap);
    if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);
    setLatest(snap);
    setTick((t) => t + 1);
  }, []);

  // Initial paint via REST so we don't wait a full second for the WS.
  useEffect(() => {
    let cancelled = false;
    getSystemSnapshot(nodeID)
      .then((snap) => {
        if (!cancelled && snap) push(snap);
      })
      .catch(() => {
        // Toasted globally.
      });
    return () => {
      cancelled = true;
    };
  }, [nodeID, push]);

  // WS lifecycle. Reconnect with simple backoff (1s → 5s) on drop.
  // `paused` is in deps so toggling it tears down / re-establishes
  // the socket — paused=true short-circuits before any open() so the
  // server-side fan-out hub sees the unsub and stops ticking too
  // (real resource release, not just frame-dropping on the client).
  useEffect(() => {
    if (paused) {
      setConnected(false);
      return;
    }
    let stopped = false;
    let ws: WebSocket | null = null;
    let backoff = 1000;
    let retry: number | null = null;

    const open = () => {
      if (stopped) return;
      ws = new WebSocket(systemStreamURL(nodeID));
      ws.onopen = () => {
        backoff = 1000;
        setConnected(true);
      };
      ws.onmessage = (e) => {
        try {
          const snap: SystemSnapshot = JSON.parse(e.data);
          push(snap);
        } catch {
          /* skip malformed frame */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (stopped) return;
        retry = window.setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 5000);
      };
      ws.onerror = () => {
        // onclose will follow with the actual cleanup.
      };
    };
    open();

    return () => {
      stopped = true;
      if (retry !== null) window.clearTimeout(retry);
      if (ws) ws.close();
    };
  }, [nodeID, push, paused]);

  // Reset scroll on mount — see P18 cross-page scroll-reset memory
  // (other fixed-viewport pages inherited scrollTop from previous page
  // and pushed our header out of view).
  useEffect(() => {
    let el: HTMLElement | null = document.scrollingElement as HTMLElement | null;
    while (el) {
      el.scrollTop = 0;
      el = el.parentElement;
    }
    window.scrollTo(0, 0);
  }, []);

  const isServer = latest?.identity.kind === 'server';
  const isWorker = latest?.identity.kind === 'worker';

  // ─── KPI cards (top row, derived from latest) ──────────────────────
  // CPU% = process busy CPU-seconds / wall-clock CPU-seconds over the
  // last 2 ring buffer samples. cpu_total includes idle, so this is
  // a clean utilization ratio in [0, 1].
  //
  // CPU cores = busy CPU-seconds / wall seconds — direct "how many
  // cores worth of work were we doing in the last second". A process
  // pinning 2 full cores reports 2.0, one barely-busy goroutine 0.05.
  const cpuStats = useMemo(() => {
    const ring = ringRef.current;
    if (ring.length < 2) return { pct: 0, cores: 0 };
    const a = ring[ring.length - 2];
    const b = ring[ring.length - 1];
    const ar = a.runtime;
    const br = b.runtime;
    const totalDelta = br.cpu_total_seconds - ar.cpu_total_seconds;
    const busyDelta =
      br.cpu_user_seconds +
      br.cpu_gc_seconds +
      br.cpu_scavenge_seconds -
      (ar.cpu_user_seconds + ar.cpu_gc_seconds + ar.cpu_scavenge_seconds);
    const wallSec = (new Date(b.at).getTime() - new Date(a.at).getTime()) / 1000;
    const pct = totalDelta > 0 ? Math.max(0, Math.min(1, busyDelta / totalDelta)) : 0;
    const cores = wallSec > 0 ? Math.max(0, busyDelta / wallSec) : 0;
    return { pct, cores };
    // tick intentionally drives recompute via consumer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const memPct = useMemo(() => {
    if (!latest) return 0;
    const r = latest.runtime;
    if (r.rss_bytes <= 0 || r.mem_total_bytes <= 0) return 0;
    return Math.max(0, Math.min(1, r.rss_bytes / r.mem_total_bytes));
  }, [latest]);

  const kpis = latest
    ? [
        {
          title: intl.formatMessage({ id: 'system.kpi.uptime' }),
          value: formatDurationSeconds(latest.identity.uptime_seconds),
        },
        {
          title: intl.formatMessage({ id: 'system.col.goroutines' }),
          value: formatBigNumber(latest.runtime.goroutines),
        },
        // CPU: percent + cores side by side in one card so the 8-card
        // grid stays balanced. cores/numCPU gives operator the "am I
        // capacity-bound?" answer at a glance (1.0 / 8 = lots of room,
        // 7.5 / 8 = near saturation).
        {
          title: intl.formatMessage({ id: 'system.kpi.cpu' }),
          value: formatPercent(cpuStats.pct),
          sub: `${cpuStats.cores.toFixed(2)} / ${latest.identity.num_cpu} ${intl.formatMessage({ id: 'system.kpi.coresUnit' })}`,
        },
        // Memory: percent + absolute RSS. Falls back to "RSS only"
        // when mem_total isn't available (macOS / Windows dev).
        {
          title: intl.formatMessage({ id: 'system.kpi.memory' }),
          value:
            latest.runtime.mem_total_bytes > 0 && latest.runtime.rss_bytes > 0
              ? formatPercent(memPct)
              : '—',
          // Compact form (e.g. "512M / 16G" instead of "512.00 MiB /
          // 16.00 GiB") so the line fits one row inside the narrow
          // `lg={3}` KPI card without the ellipsis truncation; the
          // full-precision value is exposed via the Card-level
          // tooltip below in case operators want it.
          sub:
            latest.runtime.rss_bytes > 0
              ? latest.runtime.mem_total_bytes > 0
                ? `${formatBytes(latest.runtime.rss_bytes, { compact: true })} / ${formatBytes(latest.runtime.mem_total_bytes, { compact: true })}`
                : formatBytes(latest.runtime.rss_bytes, { compact: true })
              : '—',
          subFull:
            latest.runtime.rss_bytes > 0
              ? latest.runtime.mem_total_bytes > 0
                ? `${formatBytes(latest.runtime.rss_bytes)} / ${formatBytes(latest.runtime.mem_total_bytes)}`
                : formatBytes(latest.runtime.rss_bytes)
              : undefined,
        },
        {
          title: intl.formatMessage({ id: 'system.col.heap' }),
          value: formatBytes(latest.runtime.heap_inuse_bytes),
        },
        {
          title: intl.formatMessage({ id: 'system.kpi.gcPause' }),
          value: formatMillis(latest.runtime.gc_pause_p99_seconds),
        },
        {
          title: intl.formatMessage({ id: 'system.kpi.schedLat' }),
          value: formatMillis(latest.runtime.sched_latency_p99_seconds),
        },
        {
          title: intl.formatMessage({ id: 'system.kpi.fds' }),
          value:
            latest.runtime.open_fds > 0
              ? `${latest.runtime.open_fds} / ${latest.runtime.max_fds}`
              : '—',
        },
      ]
    : [];

  // ─── Chart series derivation (memoized) ───────────────────────────
  // Each chart maps the ring buffer to one or more SystemSeries.
  // Recomputed when tick changes (one new snapshot arrived).
  const series = useMemo(() => mapSeries(ringRef.current, isWorker), [tick, isWorker]);

  // Pprof confirm Modal.
  const [confirmKind, setConfirmKind] = useState<{ kind: string; seconds?: number } | null>(null);
  const openPprof = (kind: string, seconds?: number, confirm = false) => {
    const url = pprofURL(nodeID, kind, { seconds, confirm });
    window.open(url, '_blank');
  };

  return (
    <PageContainer
      header={{
        title: nodeTitle(intl, latest, nodeID, isServer),
        breadcrumb: {},
        onBack: () => history.push('/system'),
      }}
      extra={[
        latest && (
          <Tag key="ver" color="default">
            {latest.identity.app_version} · {latest.identity.go_version}
          </Tag>
        ),
        <Tag
          key="ws"
          color={paused ? 'default' : connected ? 'success' : 'warning'}
        >
          {paused ? 'WS ⏸' : connected ? 'WS ●' : 'WS ○'}
        </Tag>,
        <Button
          key="pause"
          size="small"
          icon={paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
          onClick={() => setPaused((p) => !p)}
        >
          {intl.formatMessage({
            id: paused ? 'system.action.resume' : 'system.action.pause',
          })}
        </Button>,
      ]}
    >
      {!connected && !paused && latest && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={intl.formatMessage({ id: 'system.detail.disconnected' })}
        />
      )}
      {paused && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={intl.formatMessage({ id: 'system.detail.paused' })}
        />
      )}

      {/* 8 KPI cards row. Row align="stretch" + Card style.height=100%
          keeps every cell the same height regardless of whether `sub`
          is present — cards without a sub-line render an empty
          placeholder div of matching height so the value line stays
          vertically aligned across the row. */}
      <Row gutter={[12, 12]} align="stretch" style={{ marginBottom: 12 }}>
        {kpis.map((k) => {
          const subEl = (
            <div
              style={{
                marginTop: 4,
                fontSize: 12,
                minHeight: 18, // reserve room for `sub` even when absent
                color: 'var(--ant-color-text-tertiary, #999)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {k.sub || ' '}
            </div>
          );
          return (
            <Col key={k.title} xs={12} sm={8} md={6} lg={3}>
              <Card size="small" style={{ height: '100%' }}>
                <Statistic title={k.title} value={k.value} />
                {k.subFull ? (
                  <Tooltip title={k.subFull} placement="bottom">
                    {subEl}
                  </Tooltip>
                ) : (
                  subEl
                )}
              </Card>
            </Col>
          );
        })}
      </Row>

      <Tabs
        defaultActiveKey="overview"
        destroyOnHidden
        items={[
          {
            key: 'overview',
            label: intl.formatMessage({ id: 'system.tab.overview' }),
            children: (
              <React.Suspense fallback={null}>
                <Row gutter={[12, 12]}>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.cpu' })}
                      unit="%"
                      series={series.cpu}
                      decimals={1}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.cpuCores' })}
                      unit={intl.formatMessage({ id: 'system.kpi.coresUnit' })}
                      series={series.cpuCores}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.goroutines' })}
                      series={series.goroutines}
                      decimals={0}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.heap' })}
                      unit="MiB"
                      unitScale={1 / (1024 * 1024)}
                      series={series.heap}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.gc' })}
                      unit="ms"
                      unitScale={1000}
                      series={series.gcPause}
                    />
                  </Col>
                </Row>
              </React.Suspense>
            ),
          },
          {
            key: 'memory',
            label: intl.formatMessage({ id: 'system.tab.memory' }),
            children: (
              <React.Suspense fallback={null}>
                <Row gutter={[12, 12]}>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.memPct' })}
                      unit="%"
                      series={series.memPct}
                      decimals={1}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.memUsage' })}
                      unit="MiB"
                      unitScale={1 / (1024 * 1024)}
                      series={series.rss}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.systemMem' })}
                      unit="MiB"
                      unitScale={1 / (1024 * 1024)}
                      series={series.systemMem}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.heapGoal' })}
                      unit="MiB"
                      unitScale={1 / (1024 * 1024)}
                      series={series.heapGoal}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.heap' })}
                      unit="MiB"
                      unitScale={1 / (1024 * 1024)}
                      series={series.heapSegments}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.allocRate' })}
                      unit="MiB/s"
                      unitScale={1 / (1024 * 1024)}
                      series={series.allocRate}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title="Live objects"
                      series={series.liveObjects}
                      decimals={0}
                    />
                  </Col>
                </Row>
              </React.Suspense>
            ),
          },
          {
            key: 'scheduler',
            label: intl.formatMessage({ id: 'system.tab.scheduler' }),
            children: (
              <React.Suspense fallback={null}>
                <Row gutter={[12, 12]}>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.cpuBreakdown' })}
                      unit={intl.formatMessage({ id: 'system.kpi.coresUnit' })}
                      series={series.cpuBreakdown}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.procVsGoCpu' })}
                      unit={intl.formatMessage({ id: 'system.kpi.coresUnit' })}
                      series={series.procVsGoCpu}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.schedLat' })}
                      unit="µs"
                      unitScale={1_000_000}
                      series={series.schedLat}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.mutexWait' })}
                      unit="s"
                      series={series.mutexWait}
                      decimals={3}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.osThreads' })}
                      series={series.osThreads}
                      decimals={0}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.diskIO' })}
                      unit="MiB/s"
                      unitScale={1 / (1024 * 1024)}
                      series={series.diskIO}
                    />
                  </Col>
                </Row>
              </React.Suspense>
            ),
          },
          isServer && {
            key: 'network',
            label: intl.formatMessage({ id: 'system.tab.network' }),
            children: (
              <React.Suspense fallback={null}>
                <Row gutter={[12, 12]}>
                  <Col xs={24}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.streams' })}
                      series={series.streamsByCluster}
                      decimals={0}
                    />
                  </Col>
                </Row>
              </React.Suspense>
            ),
          },
          isServer && {
            key: 'http',
            label: intl.formatMessage({ id: 'system.tab.http' }),
            children: (
              <React.Suspense fallback={null}>
                <Row gutter={[12, 12]}>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.http' })}
                      series={series.httpRPS}
                      decimals={0}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title="HTTP latency (p50/p90/p99)"
                      unit="ms"
                      series={series.httpLatency}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title="HTTP in-flight"
                      series={series.httpInflight}
                      decimals={0}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title="SSE clients + inference in-flight"
                      series={series.sseInference}
                      decimals={0}
                    />
                  </Col>
                </Row>
              </React.Suspense>
            ),
          },
          isServer && {
            key: 'db',
            label: intl.formatMessage({ id: 'system.tab.db' }),
            children: (
              <React.Suspense fallback={null}>
                <Row gutter={[12, 12]}>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.db' })}
                      series={series.dbPool}
                      decimals={0}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title="DB wait"
                      series={series.dbWait}
                    />
                  </Col>
                </Row>
              </React.Suspense>
            ),
          },
          isWorker && {
            key: 'proxy',
            label: intl.formatMessage({ id: 'system.tab.proxy' }),
            children: (
              <React.Suspense fallback={null}>
                <Row gutter={[12, 12]}>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.proxyInflight' })}
                      series={series.proxyInflight}
                      decimals={0}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.router' })}
                      unit="%"
                      unitScale={100}
                      series={series.routerHit}
                      decimals={1}
                    />
                  </Col>
                </Row>
              </React.Suspense>
            ),
          },
          {
            key: 'pprof',
            label: intl.formatMessage({ id: 'system.tab.pprof' }),
            children: (
              <Card size="small">
                <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
                  {intl.formatMessage({ id: 'system.pprof.hint' })}
                </Typography.Paragraph>
                <Space wrap>
                  {PPROF_ITEMS.map((it) => (
                    <Button
                      key={it.kind}
                      type={it.cost === 'high' ? 'default' : 'primary'}
                      danger={it.cost === 'high'}
                      icon={<DownloadOutlined />}
                      onClick={() => {
                        if (it.cost === 'high') {
                          setConfirmKind({ kind: it.kind, seconds: it.seconds });
                        } else {
                          openPprof(it.kind);
                        }
                      }}
                    >
                      {intl.formatMessage({ id: it.labelId })}
                    </Button>
                  ))}
                </Space>
              </Card>
            ),
          },
        ].filter(Boolean) as { key: string; label: React.ReactNode; children: React.ReactNode }[]}
      />

      <Modal
        open={!!confirmKind}
        title={intl.formatMessage({ id: 'system.pprof.confirmTitle' })}
        onCancel={() => setConfirmKind(null)}
        onOk={() => {
          if (confirmKind) openPprof(confirmKind.kind, confirmKind.seconds, true);
          setConfirmKind(null);
        }}
        okText={intl.formatMessage({ id: 'system.pprof.confirmOk' })}
        cancelText={intl.formatMessage({ id: 'system.pprof.cancel' })}
        okButtonProps={{ danger: true }}
      >
        <Typography.Paragraph>
          {intl.formatMessage({ id: 'system.pprof.confirmBody' })}
        </Typography.Paragraph>
      </Modal>
    </PageContainer>
  );
}

function nodeTitle(
  intl: ReturnType<typeof useIntl>,
  latest: SystemSnapshot | null,
  nodeID: string,
  isServer: boolean,
) {
  if (!latest) return nodeID;
  if (isServer) {
    return (
      <Space>
        <Tag color="processing">{intl.formatMessage({ id: 'system.kind.server' })}</Tag>
        <span>control-plane</span>
      </Space>
    );
  }
  return (
    <Space>
      <Tag color="default">{intl.formatMessage({ id: 'system.kind.worker' })}</Tag>
      <span>{latest.identity.name || nodeID}</span>
    </Space>
  );
}

// ─── Series derivation ─────────────────────────────────────────────

interface AllSeries {
  goroutines: SystemSeries[];
  heap: SystemSeries[];
  gcPause: SystemSeries[];
  cpu: SystemSeries[];
  cpuCores: SystemSeries[];
  cpuBreakdown: SystemSeries[]; // user / gc / scavenge in cores
  procVsGoCpu: SystemSeries[]; // kernel-counted vs Go runtime CPU
  osThreads: SystemSeries[];
  heapSegments: SystemSeries[];
  heapGoal: SystemSeries[]; // heap_inuse + heap_goal overlay
  rss: SystemSeries[];
  memPct: SystemSeries[];
  systemMem: SystemSeries[]; // system used + available (host view)
  allocRate: SystemSeries[];
  liveObjects: SystemSeries[];
  diskIO: SystemSeries[]; // process read/write bytes per sec
  schedLat: SystemSeries[];
  mutexWait: SystemSeries[];
  streamsByCluster: SystemSeries[];
  httpRPS: SystemSeries[];
  httpLatency: SystemSeries[];
  httpInflight: SystemSeries[];
  sseInference: SystemSeries[];
  dbPool: SystemSeries[];
  dbWait: SystemSeries[];
  proxyInflight: SystemSeries[];
  routerHit: SystemSeries[];
}

function mapSeries(ring: SystemSnapshot[], _isWorker: boolean): AllSeries {
  if (ring.length === 0) {
    return emptySeries();
  }
  const ts = ring.map((s) => new Date(s.at).getTime());

  // Helpers — slice across the ring with one series.
  const single = (name: string, get: (s: SystemSnapshot) => number): SystemSeries[] => [
    { name, points: ring.map((s, i) => ({ t: ts[i], v: get(s) })) },
  ];
  const multi = (
    names: { name: string; get: (s: SystemSnapshot) => number }[],
  ): SystemSeries[] =>
    names.map(({ name, get }) => ({
      name,
      points: ring.map((s, i) => ({ t: ts[i], v: get(s) })),
    }));

  // CPU% — per-tick delta over total. Needs i and i-1. First tick = 0.
  // cpuCores = busy_delta_seconds / wall_delta_seconds — same source,
  // different denominator (wall time vs cpu_total_seconds which is
  // wall × GOMAXPROCS).
  //
  // cpuBreakdown lines (user / gc / scavenge cores): same delta math
  // per class. Operator can see at a glance whether CPU is "real
  // work" (user climbs) or "GC pressure" (gc climbs).
  //
  // procVsGoCpu compares the kernel-counted process_cpu_user_seconds
  // against runtime/metrics' cpu_user_seconds. They should track
  // tightly; divergence usually means cgo or cgroup throttling.
  const cpuPoints: { t: number; v: number }[] = [];
  const cpuCoresPoints: { t: number; v: number }[] = [];
  const cpuUserCores: { t: number; v: number }[] = [];
  const cpuGCCores: { t: number; v: number }[] = [];
  const cpuScavengeCores: { t: number; v: number }[] = [];
  const procCpuCores: { t: number; v: number }[] = [];
  const goCpuCores: { t: number; v: number }[] = [];
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1].runtime;
    const b = ring[i].runtime;
    const totalDelta = b.cpu_total_seconds - a.cpu_total_seconds;
    const wallSec = (ts[i] - ts[i - 1]) / 1000;
    const userDelta = b.cpu_user_seconds - a.cpu_user_seconds;
    const gcDelta = b.cpu_gc_seconds - a.cpu_gc_seconds;
    const scavDelta = b.cpu_scavenge_seconds - a.cpu_scavenge_seconds;
    const busyDelta = userDelta + gcDelta + scavDelta;
    if (totalDelta <= 0) {
      cpuPoints.push({ t: ts[i], v: 0 });
    } else {
      cpuPoints.push({
        t: ts[i],
        v: Math.max(0, Math.min(100, (busyDelta / totalDelta) * 100)),
      });
    }
    cpuCoresPoints.push({
      t: ts[i],
      v: wallSec > 0 ? Math.max(0, busyDelta / wallSec) : 0,
    });
    cpuUserCores.push({ t: ts[i], v: wallSec > 0 ? Math.max(0, userDelta / wallSec) : 0 });
    cpuGCCores.push({ t: ts[i], v: wallSec > 0 ? Math.max(0, gcDelta / wallSec) : 0 });
    cpuScavengeCores.push({
      t: ts[i],
      v: wallSec > 0 ? Math.max(0, scavDelta / wallSec) : 0,
    });
    // Process vs Runtime CPU compares kernel user+system against
    // Go's cpu_user_seconds (Go's accounting doesn't break out
    // "system" — kernel does). Plot kernel total (user+sys) and Go
    // total (user only, since Go has no separate sys metric).
    const procUserDelta = b.process_cpu_user_seconds - a.process_cpu_user_seconds;
    const procSysDelta = b.process_cpu_system_seconds - a.process_cpu_system_seconds;
    procCpuCores.push({
      t: ts[i],
      v: wallSec > 0 ? Math.max(0, (procUserDelta + procSysDelta) / wallSec) : 0,
    });
    goCpuCores.push({
      t: ts[i],
      v: wallSec > 0 ? Math.max(0, userDelta / wallSec) : 0,
    });
  }

  // Disk I/O bytes/sec from process_io_{read,write}_bytes deltas.
  // Linux-only (0 elsewhere). Series stays at 0 on macOS/Windows.
  const ioReadPoints: { t: number; v: number }[] = [];
  const ioWritePoints: { t: number; v: number }[] = [];
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1].runtime;
    const b = ring[i].runtime;
    const dt = (ts[i] - ts[i - 1]) / 1000;
    if (dt <= 0) {
      ioReadPoints.push({ t: ts[i], v: 0 });
      ioWritePoints.push({ t: ts[i], v: 0 });
      continue;
    }
    ioReadPoints.push({
      t: ts[i],
      v: Math.max(0, (b.process_io_read_bytes - a.process_io_read_bytes) / dt),
    });
    ioWritePoints.push({
      t: ts[i],
      v: Math.max(0, (b.process_io_write_bytes - a.process_io_write_bytes) / dt),
    });
  }

  // Alloc rate (MiB/s — but unit scaling happens in the chart).
  const allocPoints: { t: number; v: number }[] = [];
  for (let i = 1; i < ring.length; i++) {
    const dt = (ts[i] - ts[i - 1]) / 1000;
    if (dt <= 0) {
      allocPoints.push({ t: ts[i], v: 0 });
      continue;
    }
    const delta =
      ring[i].runtime.total_alloc_bytes - ring[i - 1].runtime.total_alloc_bytes;
    allocPoints.push({ t: ts[i], v: Math.max(0, delta / dt) });
  }

  // Streams by cluster (server only, yamux.streams_by_cluster).
  // Series label resolution: server ships cluster_names in the same
  // snapshot, so we look up the human name keyed by cluster_id and
  // fall back to a truncated UUID when the name is missing (cluster
  // disconnected mid-window, or pre-cache-warmup edge).
  const streamSeriesMap: Map<string, { t: number; v: number }[]> = new Map();
  const latestNames: Record<string, string> = {};
  ring.forEach((s, i) => {
    const yamux = s.custom?.yamux as
      | { streams_by_cluster?: Record<string, number>; cluster_names?: Record<string, string> }
      | undefined;
    if (!yamux?.streams_by_cluster) return;
    if (yamux.cluster_names) {
      for (const [cid, name] of Object.entries(yamux.cluster_names)) {
        if (name) latestNames[cid] = name;
      }
    }
    for (const [cid, n] of Object.entries(yamux.streams_by_cluster)) {
      if (!streamSeriesMap.has(cid)) streamSeriesMap.set(cid, []);
      streamSeriesMap.get(cid)!.push({ t: ts[i], v: Number(n) || 0 });
    }
  });
  const streamsByCluster: SystemSeries[] = Array.from(streamSeriesMap.entries()).map(
    ([cid, points]) => ({ name: latestNames[cid] || cid.slice(0, 8), points }),
  );

  // HTTP custom collector.
  const httpRPS = multi([
    {
      name: 'RPS',
      get: (s) =>
        Number((s.custom?.http as { requests_per_sec?: number } | undefined)?.requests_per_sec) || 0,
    },
    {
      name: '5xx',
      get: (s) =>
        Number((s.custom?.http as { status_5xx_per_sec?: number } | undefined)?.status_5xx_per_sec) ||
        0,
    },
  ]);
  const httpLatency = multi([
    {
      name: 'p50',
      get: (s) =>
        Number((s.custom?.http as { latency_p50_ms?: number } | undefined)?.latency_p50_ms) || 0,
    },
    {
      name: 'p90',
      get: (s) =>
        Number((s.custom?.http as { latency_p90_ms?: number } | undefined)?.latency_p90_ms) || 0,
    },
    {
      name: 'p99',
      get: (s) =>
        Number((s.custom?.http as { latency_p99_ms?: number } | undefined)?.latency_p99_ms) || 0,
    },
  ]);
  const httpInflight = single('in-flight', (s) =>
    Number((s.custom?.http as { in_flight?: number } | undefined)?.in_flight) || 0,
  );
  const sseInference = multi([
    {
      name: 'sse_clients',
      get: (s) =>
        Number((s.custom?.inference as { sse_clients?: number } | undefined)?.sse_clients) || 0,
    },
    {
      name: 'inference_inflight',
      get: (s) =>
        Number((s.custom?.inference as { inflight?: number } | undefined)?.inflight) || 0,
    },
  ]);

  // DB pool.
  const dbPool = multi([
    {
      name: 'open',
      get: (s) =>
        Number((s.custom?.db as { open_connections?: number } | undefined)?.open_connections) || 0,
    },
    {
      name: 'in_use',
      get: (s) => Number((s.custom?.db as { in_use?: number } | undefined)?.in_use) || 0,
    },
    {
      name: 'idle',
      get: (s) => Number((s.custom?.db as { idle?: number } | undefined)?.idle) || 0,
    },
  ]);
  const dbWait = multi([
    {
      name: 'wait_count',
      get: (s) => Number((s.custom?.db as { wait_count?: number } | undefined)?.wait_count) || 0,
    },
    {
      name: 'wait_seconds',
      get: (s) =>
        Number(
          (s.custom?.db as { wait_duration_seconds?: number } | undefined)?.wait_duration_seconds,
        ) || 0,
    },
  ]);

  // Worker proxy / router.
  const proxyInflight = multi([
    { name: 'resource', get: (s) => num(s.custom?.proxy, 'inflight_resource') },
    { name: 'http', get: (s) => num(s.custom?.proxy, 'inflight_http_proxy') },
    { name: 'logs', get: (s) => num(s.custom?.proxy, 'inflight_logs') },
    { name: 'exec', get: (s) => num(s.custom?.proxy, 'inflight_exec') },
    { name: 'ws', get: (s) => num(s.custom?.proxy, 'inflight_ws') },
  ]);
  const routerHit = single('hit_rate', (s) => num(s.custom?.in_cluster_router, 'hit_rate'));

  return {
    goroutines: single('goroutines', (s) => s.runtime.goroutines),
    heap: single('heap_inuse', (s) => s.runtime.heap_inuse_bytes),
    gcPause: multi([
      { name: 'p50', get: (s) => s.runtime.gc_pause_p50_seconds },
      { name: 'p90', get: (s) => s.runtime.gc_pause_p90_seconds },
      { name: 'p99', get: (s) => s.runtime.gc_pause_p99_seconds },
    ]),
    cpu: [{ name: 'busy %', points: cpuPoints }],
    cpuCores: [{ name: 'cores', points: cpuCoresPoints }],
    cpuBreakdown: [
      { name: 'user', points: cpuUserCores },
      { name: 'gc', points: cpuGCCores },
      { name: 'scavenge', points: cpuScavengeCores },
    ],
    procVsGoCpu: [
      { name: 'kernel (user+sys)', points: procCpuCores },
      { name: 'go runtime (user)', points: goCpuCores },
    ],
    osThreads: single('threads', (s) => s.runtime.os_threads),
    heapSegments: multi([
      { name: 'inuse', get: (s) => s.runtime.heap_inuse_bytes },
      { name: 'idle', get: (s) => s.runtime.heap_idle_bytes },
      { name: 'released', get: (s) => s.runtime.heap_released_bytes },
      { name: 'stacks', get: (s) => s.runtime.stack_inuse_bytes },
      { name: 'runtime', get: (s) => s.runtime.runtime_overhead_bytes },
    ]),
    rss: single('rss', (s) => s.runtime.rss_bytes),
    memPct: [
      {
        name: 'rss / total',
        points: ring.map((s, i) => ({
          t: ts[i],
          v:
            s.runtime.mem_total_bytes > 0 && s.runtime.rss_bytes > 0
              ? (s.runtime.rss_bytes / s.runtime.mem_total_bytes) * 100
              : 0,
        })),
      },
    ],
    systemMem: [
      { name: 'used', points: ring.map((s, i) => ({ t: ts[i], v: s.runtime.system_mem_used_bytes })) },
      { name: 'available', points: ring.map((s, i) => ({ t: ts[i], v: s.runtime.system_mem_available_bytes })) },
    ],
    heapGoal: [
      { name: 'inuse', points: ring.map((s, i) => ({ t: ts[i], v: s.runtime.heap_inuse_bytes })) },
      { name: 'goal', points: ring.map((s, i) => ({ t: ts[i], v: s.runtime.heap_goal_bytes })) },
    ],
    diskIO: [
      { name: 'read/s', points: ioReadPoints },
      { name: 'write/s', points: ioWritePoints },
    ],
    allocRate: [{ name: 'alloc/s', points: allocPoints }],
    liveObjects: single('objects', (s) => s.runtime.live_objects),
    schedLat: multi([
      { name: 'p50', get: (s) => s.runtime.sched_latency_p50_seconds },
      { name: 'p90', get: (s) => s.runtime.sched_latency_p90_seconds },
      { name: 'p99', get: (s) => s.runtime.sched_latency_p99_seconds },
    ]),
    mutexWait: single('wait', (s) => s.runtime.mutex_wait_total_seconds),
    streamsByCluster,
    httpRPS,
    httpLatency,
    httpInflight,
    sseInference,
    dbPool,
    dbWait,
    proxyInflight,
    routerHit,
  };
}

function num(custom: Record<string, unknown> | undefined, key: string): number {
  if (!custom) return 0;
  const v = custom[key];
  return typeof v === 'number' ? v : 0;
}

function emptySeries(): AllSeries {
  return {
    goroutines: [],
    heap: [],
    gcPause: [],
    cpu: [],
    cpuCores: [],
    cpuBreakdown: [],
    procVsGoCpu: [],
    osThreads: [],
    heapGoal: [],
    systemMem: [],
    diskIO: [],
    memPct: [],
    heapSegments: [],
    rss: [],
    allocRate: [],
    liveObjects: [],
    schedLat: [],
    mutexWait: [],
    streamsByCluster: [],
    httpRPS: [],
    httpLatency: [],
    httpInflight: [],
    sseInference: [],
    dbPool: [],
    dbWait: [],
    proxyInflight: [],
    routerHit: [],
  };
}
