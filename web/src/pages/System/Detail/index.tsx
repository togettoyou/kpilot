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
  Typography,
} from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
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
  useEffect(() => {
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
  }, [nodeID, push]);

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
  const cpuPct = useMemo(() => {
    const ring = ringRef.current;
    if (ring.length < 2) return 0;
    const a = ring[ring.length - 2].runtime;
    const b = ring[ring.length - 1].runtime;
    const totalDelta = b.cpu_total_seconds - a.cpu_total_seconds;
    if (totalDelta <= 0) return 0;
    const busyDelta =
      b.cpu_user_seconds +
      b.cpu_gc_seconds +
      b.cpu_scavenge_seconds -
      (a.cpu_user_seconds + a.cpu_gc_seconds + a.cpu_scavenge_seconds);
    return Math.max(0, Math.min(1, busyDelta / totalDelta));
    // tick intentionally drives recompute via consumer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

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
          title: intl.formatMessage({ id: 'system.kpi.cpu' }),
          value: formatPercent(cpuPct),
        },
        {
          title: intl.formatMessage({ id: 'system.col.rss' }),
          value:
            latest.runtime.rss_bytes > 0 ? formatBytes(latest.runtime.rss_bytes) : '—',
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
        <Tag key="ws" color={connected ? 'success' : 'warning'}>
          {connected ? 'WS ●' : 'WS ○'}
        </Tag>,
      ]}
    >
      {!connected && latest && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={intl.formatMessage({ id: 'system.detail.disconnected' })}
        />
      )}

      {/* 8 KPI cards row */}
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        {kpis.map((k) => (
          <Col key={k.title} xs={12} sm={8} md={6} lg={3}>
            <Card size="small">
              <Statistic title={k.title} value={k.value} />
            </Card>
          </Col>
        ))}
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
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.cpu' })}
                      unit="%"
                      series={series.cpu}
                      decimals={1}
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
                      title={intl.formatMessage({ id: 'system.chart.heap' })}
                      unit="MiB"
                      unitScale={1 / (1024 * 1024)}
                      series={series.heapSegments}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.rss' })}
                      unit="MiB"
                      unitScale={1 / (1024 * 1024)}
                      series={series.rss}
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
  heapSegments: SystemSeries[];
  rss: SystemSeries[];
  allocRate: SystemSeries[];
  liveObjects: SystemSeries[];
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
  const cpuPoints: { t: number; v: number }[] = [];
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1].runtime;
    const b = ring[i].runtime;
    const totalDelta = b.cpu_total_seconds - a.cpu_total_seconds;
    if (totalDelta <= 0) {
      cpuPoints.push({ t: ts[i], v: 0 });
      continue;
    }
    const busyDelta =
      b.cpu_user_seconds +
      b.cpu_gc_seconds +
      b.cpu_scavenge_seconds -
      (a.cpu_user_seconds + a.cpu_gc_seconds + a.cpu_scavenge_seconds);
    cpuPoints.push({ t: ts[i], v: Math.max(0, Math.min(100, (busyDelta / totalDelta) * 100)) });
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
    heapSegments: multi([
      { name: 'inuse', get: (s) => s.runtime.heap_inuse_bytes },
      { name: 'idle', get: (s) => s.runtime.heap_idle_bytes },
      { name: 'released', get: (s) => s.runtime.heap_released_bytes },
      { name: 'stacks', get: (s) => s.runtime.stack_inuse_bytes },
      { name: 'runtime', get: (s) => s.runtime.runtime_overhead_bytes },
    ]),
    rss: single('rss', (s) => s.runtime.rss_bytes),
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
