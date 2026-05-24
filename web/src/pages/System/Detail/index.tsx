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
  Spin,
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
  listSystemHistory,
  pprofURL,
  type SystemSnapshot,
} from '@/services/kpilot/system';
import TimeRangePicker, {
  buildRangeQuery,
  type TimeRangeValue,
} from '@/components/TimeRangePicker';
import {
  formatBigNumber,
  formatBytes,
  formatDurationSeconds,
  formatMillis,
  formatPercent,
} from '../format';

const SystemChart = React.lazy(() => import('./SystemChart'));
import type { SystemSeries } from './SystemChart';

// Ring buffer is bounded — backend retains ~1 h at 15 s polling
// = 240 samples × ~2 KB JSON ≈ 480 KB per tab. We cap a bit higher
// (300) to absorb minor timing drift / cross-day overlap without
// dropping points. Server-side history is the source of truth; the
// local ring is just for chart rendering.
const RING_CAPACITY = 300;
// 15 s matches the backend poller cadence. Going faster would
// download the same row twice; going slower would lag behind the
// fresh data the poller just landed.
const POLL_INTERVAL_MS = 15_000;

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
  // lastAtRef tracks the most recent `at` timestamp we've ingested
  // so the 1 h live mode can ask for ?since=lastAt and download only
  // new rows. Reset on range change / replace.
  const lastAtRef = useRef<string>('');
  const [tick, setTick] = useState(0);
  const [latest, setLatest] = useState<SystemSnapshot | null>(null);
  // `initialLoading` covers the first history fetch (and any
  // subsequent range change that triggers a non-incremental refetch).
  // A 24h history pull can take seconds on a busy server — without
  // this the page renders a blank toolbar + empty KPI row, which
  // looks frozen. Cleared after the first response (success OR
  // error) so a slow / failing node still surfaces SOMETHING.
  const [initialLoading, setInitialLoading] = useState(true);
  // `paused` toggles the 15 s history poll. Paused = no new fetches;
  // already-rendered ring stays on screen so the operator can
  // inspect a frozen snapshot during triage.
  const [paused, setPaused] = useState(false);
  // Time range — default 1 h preset (= "live" mode). Other presets
  // and absolute ranges trigger non-incremental polling (server-side
  // downsampled, full replace per tick).
  const [range, setRange] = useState<TimeRangeValue>({ mode: 'preset', preset: '1h' });
  const isLive = range.mode === 'preset' && range.preset === '1h';

  // pushHistory appends rows STRICTLY NEWER than the current tail —
  // used by the 1 h live mode's incremental polling so a refetch with
  // ?since=lastAt doesn't duplicate the boundary row.
  const pushHistory = useCallback((items: { at: string; snapshot: SystemSnapshot }[]) => {
    if (items.length === 0) return;
    const ring = ringRef.current;
    let anyNew = false;
    for (const it of items) {
      if (it.at <= lastAtRef.current) continue;
      ring.push(it.snapshot);
      lastAtRef.current = it.at;
      anyNew = true;
    }
    if (!anyNew) return;
    if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);
    setLatest(ring[ring.length - 1]);
    setTick((t) => t + 1);
  }, []);

  // replaceHistory rebuilds the ring from scratch with the supplied
  // batch — used on (a) initial fetch, (b) range change, and (c)
  // every polling tick when the range isn't the 1 h live mode (the
  // server-side downsampling step would otherwise shift on each tick
  // and produce a jittery chart if we tried to do since-incrementals).
  const replaceHistory = useCallback((items: { at: string; snapshot: SystemSnapshot }[]) => {
    ringRef.current = [];
    lastAtRef.current = '';
    if (items.length === 0) {
      setLatest(null);
      setTick((t) => t + 1);
      return;
    }
    for (const it of items) {
      ringRef.current.push(it.snapshot);
      lastAtRef.current = it.at;
    }
    if (ringRef.current.length > RING_CAPACITY) {
      ringRef.current.splice(0, ringRef.current.length - RING_CAPACITY);
    }
    setLatest(ringRef.current[ringRef.current.length - 1]);
    setTick((t) => t + 1);
  }, []);

  // Stale = the most recent sample is older than 2× the polling
  // interval (≈ "the poller missed at least 2 ticks"). For an
  // offline worker that means we're looking at frozen history —
  // pprof can't reach the node, charts won't refresh until the
  // worker reconnects and the poller catches up.
  //
  // For the server node this can also briefly fire during a slow
  // poll, but resolves on the next successful insert.
  const stale = useMemo(() => {
    if (!lastAtRef.current) return false; // no data yet ≠ stale
    const ageMs = Date.now() - new Date(lastAtRef.current).getTime();
    return ageMs > POLL_INTERVAL_MS * 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  // Initial fetch: pull the chosen range so the chart paints with
  // full context immediately. Reruns on node OR range change —
  // either resets the ring, then loads fresh. Flips initialLoading
  // off on the first settle (success or failure) so a broken /
  // slow node still escapes the spinner.
  useEffect(() => {
    let cancelled = false;
    setInitialLoading(true);
    listSystemHistory(nodeID, { rangeQuery: buildRangeQuery(range) })
      .then((items) => {
        if (cancelled) return;
        replaceHistory(items || []);
      })
      .catch(() => {
        // Toasted globally.
      })
      .finally(() => {
        if (!cancelled) setInitialLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeID, range, replaceHistory]);

  // Polling: 15 s tick. Two modes:
  //   Live (range=1h preset) — ?since=lastAt incremental append.
  //   Other ranges          — full re-fetch + replace. Server-side
  //                            downsampling means the row set can
  //                            shift slightly between ticks, so
  //                            "append only newer" wouldn't compose
  //                            cleanly; cheaper to just replace.
  useEffect(() => {
    if (paused) return;
    const tick = async () => {
      try {
        if (isLive) {
          const items = await listSystemHistory(nodeID, {
            since: lastAtRef.current || undefined,
          });
          pushHistory(items || []);
        } else {
          const items = await listSystemHistory(nodeID, {
            rangeQuery: buildRangeQuery(range),
          });
          replaceHistory(items || []);
        }
      } catch {
        // Toasted globally; just try again next tick.
      }
    };
    const handle = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [nodeID, range, paused, isLive, pushHistory, replaceHistory]);

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
  // CPU% = (procUser + procSys delta) / wallSec / NumCPU over the last
  // two ring buffer samples — kernel-counted from gopsutil reading
  // /proc/<pid>/stat (same source as kubectl top / cAdvisor, so the
  // numbers agree). NumCPU reflects the cgroup CPU quota (since
  // automaxprocs), so denominator matches what the container is
  // actually allowed to use.
  //
  // CPU cores = (procUser + procSys delta) / wallSec — direct "how
  // many cores worth of work were we doing in the last second". A
  // process pinning 2 full cores reports 2.0; one barely-busy
  // goroutine 0.05.
  //
  // Runtime/metrics cpu_classes_* is intentionally NOT used for the
  // headline figure: it's the Go scheduler's view and excludes time
  // in syscall waits, so an HTTP server (mostly I/O) silently
  // undercounts by ~10× — the KPI tile showed 8% while kubectl
  // reported 99%. The per-class breakdown chart on the Scheduler
  // tab still uses cpu_classes_*; it's labeled as "what the runtime
  // is doing" and the side-by-side procVsGoCpu chart makes any
  // divergence visible.
  const cpuStats = useMemo(() => {
    const ring = ringRef.current;
    if (ring.length < 2) return { pct: 0, cores: 0 };
    const a = ring[ring.length - 2];
    const b = ring[ring.length - 1];
    const ar = a.runtime;
    const br = b.runtime;
    const wallSec = (new Date(b.at).getTime() - new Date(a.at).getTime()) / 1000;
    const procDelta =
      br.process_cpu_user_seconds +
      br.process_cpu_system_seconds -
      (ar.process_cpu_user_seconds + ar.process_cpu_system_seconds);
    if (wallSec <= 0 || procDelta < 0) return { pct: 0, cores: 0 };
    const cores = procDelta / wallSec;
    const numCPU = b.identity.num_cpu || 1;
    const pct = Math.max(0, Math.min(1, cores / numCPU));
    return { pct, cores };
    // tick intentionally drives recompute via consumer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  // Memory% uses working_set_bytes (cgroup
  // `memory.current − inactive_file`) — the same number kubelet
  // sends to `kubectl top pod`. Falls back to rss_bytes when no
  // cgroup is detected (set by the backend already, so the field
  // is always populated, but kept here for defensive 0-handling).
  const memPct = useMemo(() => {
    if (!latest) return 0;
    const r = latest.runtime;
    const used = r.working_set_bytes || r.rss_bytes;
    if (used <= 0 || r.mem_total_bytes <= 0) return 0;
    return Math.max(0, Math.min(1, used / r.mem_total_bytes));
  }, [latest]);

  // Pre-compute the memory KPI numerator + sub/subFull strings so
  // the kpis array literal stays uniformly shaped (mixed object
  // shapes in one array make TS infer a too-narrow union — kpis
  // already needs optional `sub` / `subFull` to be readable across
  // entries).
  const memUsed = latest
    ? latest.runtime.working_set_bytes || latest.runtime.rss_bytes
    : 0;
  const memTotal = latest?.runtime.mem_total_bytes ?? 0;
  const memSubCompact =
    memUsed > 0
      ? memTotal > 0
        ? `${formatBytes(memUsed, { compact: true })} / ${formatBytes(memTotal, { compact: true })}`
        : formatBytes(memUsed, { compact: true })
      : '—';
  const memSubFull =
    memUsed > 0
      ? memTotal > 0
        ? `${formatBytes(memUsed)} / ${formatBytes(memTotal)}`
        : formatBytes(memUsed)
      : undefined;

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
        // Memory: percent + absolute working-set. Working-set matches
        // `kubectl top pod` (cgroup `memory.current − inactive_file`);
        // the backend falls back to RSS on non-cgroup hosts so the
        // field is always populated. Compact form (e.g. "512M /
        // 16G") so the line fits one row in the narrow `lg={3}`
        // card without ellipsis; full precision goes in the
        // Card-level tooltip below (memSubFull).
        {
          title: intl.formatMessage({ id: 'system.kpi.memory' }),
          value: memUsed > 0 && memTotal > 0 ? formatPercent(memPct) : '—',
          sub: memSubCompact,
          subFull: memSubFull,
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

  // Identity subtitle — small gray line under the page title showing
  // host / pid / version / arch / procs. Kept out of `extra` so the
  // header bar stays uncluttered.
  const identitySubtitle = latest ? (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {latest.identity.hostname} · pid {latest.identity.pid} ·{' '}
      {latest.identity.app_version} · {latest.identity.go_version} ·{' '}
      {latest.identity.goos}/{latest.identity.goarch} ·{' '}
      {latest.runtime.gomaxprocs}/{latest.identity.num_cpu} procs
    </Typography.Text>
  ) : null;

  return (
    <PageContainer
      header={{
        title: nodeTitle(intl, latest, nodeID, isServer),
        subTitle: identitySubtitle,
        breadcrumb: {},
        onBack: () => history.push('/system/monitor'),
      }}
    >
      {/* Toolbar row — time-range picker + polling state + pause.
          Lives in the body (not the header `extra`) so identity tags
          + controls don't crush each other on narrow viewports. */}
      <Space size={8} wrap style={{ marginBottom: 12 }}>
        <TimeRangePicker
          value={range}
          onChange={setRange}
          presets={['1h', '3h', '6h', '12h', '24h']}
          maxDays={1}
        />
        <Tag color={paused ? 'default' : 'processing'}>
          {paused
            ? intl.formatMessage({ id: 'system.poll.paused' })
            : intl.formatMessage({ id: 'system.poll.live' })}
        </Tag>
        <Button
          size="small"
          icon={paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
          onClick={() => setPaused((p) => !p)}
        >
          {intl.formatMessage({
            id: paused ? 'system.action.resume' : 'system.action.pause',
          })}
        </Button>
      </Space>

      {paused && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={intl.formatMessage({ id: 'system.detail.paused' })}
        />
      )}
      {stale && !paused && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={intl.formatMessage({ id: 'system.detail.stale' })}
        />
      )}

      {/* Initial fetch in flight: show a centered spinner in place
          of the KPI row + tabs so the page doesn't render as a blank
          toolbar over empty content. The toolbar itself stays
          interactive — operator can change range / pause without
          waiting for the first response. Once data lands (or fetch
          fails / returns empty), this falls through to the normal
          KPI + Tabs render below. */}
      {initialLoading && !latest && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: 240,
          }}
        >
          <Spin size="large" />
        </div>
      )}

      {/* KPI Row + Tabs hidden during the initial-fetch window so
          the spinner above isn't accompanied by an empty Row + a
          tab strip with empty charts. After the first response
          (success OR error) this falls through and renders normally
          — even on a no-data node, an empty KPI row beats a stuck
          spinner because the toolbar is still actionable. */}
      {(!initialLoading || latest) && <>
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
            <Col key={k.title} xs={12} sm={12} md={6} lg={6}>
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
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.gcFreq' })}
                      unit="/s"
                      series={series.gcFreq}
                      decimals={2}
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
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.yamuxTotals' })}
                      series={series.yamuxTotals}
                      decimals={0}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
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
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.caches' })}
                      series={series.caches}
                      decimals={0}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.httpTotals' })}
                      series={series.httpTotals}
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
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.dbClosed' })}
                      series={series.dbClosed}
                      decimals={0}
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
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.tunnelState' })}
                      series={series.tunnelState}
                      decimals={2}
                    />
                  </Col>
                  <Col xs={24} lg={12}>
                    <SystemChart
                      title={intl.formatMessage({ id: 'system.chart.routerHits' })}
                      series={series.routerHits}
                      decimals={0}
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
                {stale && (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message={intl.formatMessage({ id: 'system.pprof.staleDisabled' })}
                  />
                )}
                {/* Split into two rows: cheap snapshot profiles on
                    top (heap / goroutine / allocs / block / mutex /
                    threadcreate), high-cost ones below (CPU profile,
                    trace). Visual separation reinforces the danger
                    boundary on top of the danger=true color. */}
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  <Space wrap>
                    {PPROF_ITEMS.filter((it) => it.cost !== 'high').map((it) => (
                      <Button
                        key={it.kind}
                        type="primary"
                        icon={<DownloadOutlined />}
                        disabled={stale}
                        onClick={() => openPprof(it.kind)}
                      >
                        {intl.formatMessage({ id: it.labelId })}
                      </Button>
                    ))}
                  </Space>
                  <Space wrap>
                    {PPROF_ITEMS.filter((it) => it.cost === 'high').map((it) => (
                      <Button
                        key={it.kind}
                        danger
                        icon={<DownloadOutlined />}
                        disabled={stale}
                        onClick={() => setConfirmKind({ kind: it.kind, seconds: it.seconds })}
                      >
                        {intl.formatMessage({ id: it.labelId })}
                      </Button>
                    ))}
                  </Space>
                </Space>
              </Card>
            ),
          },
        ].filter(Boolean) as { key: string; label: React.ReactNode; children: React.ReactNode }[]}
      />
      </>}

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
  gcPause: SystemSeries[]; // p50/p90/p99 + max
  gcFreq: SystemSeries[]; // cycles per second
  cpu: SystemSeries[];
  cpuCores: SystemSeries[];
  cpuBreakdown: SystemSeries[]; // user / gc / scavenge / idle in cores
  procVsGoCpu: SystemSeries[]; // kernel-counted vs Go runtime CPU
  osThreads: SystemSeries[];
  heapSegments: SystemSeries[]; // + total_mapped
  heapGoal: SystemSeries[]; // heap_inuse + heap_goal overlay
  rss: SystemSeries[];
  memPct: SystemSeries[];
  systemMem: SystemSeries[]; // system used + available (host view)
  allocRate: SystemSeries[];
  liveObjects: SystemSeries[];
  diskIO: SystemSeries[]; // process read/write bytes per sec
  schedLat: SystemSeries[];
  mutexWait: SystemSeries[];
  yamuxTotals: SystemSeries[]; // sessions + streams_open (server only)
  streamsByCluster: SystemSeries[];
  httpRPS: SystemSeries[];
  httpTotals: SystemSeries[]; // requests_total + status_5xx_total
  httpLatency: SystemSeries[];
  httpInflight: SystemSeries[];
  sseInference: SystemSeries[]; // inflight + sse_clients + lifetime total
  dbPool: SystemSeries[];
  dbWait: SystemSeries[];
  dbClosed: SystemSeries[]; // max_idle_closed + max_lifetime_closed
  proxyInflight: SystemSeries[];
  tunnelState: SystemSeries[]; // streams_open + reconnect_total + uptime (worker)
  routerHit: SystemSeries[];
  routerHits: SystemSeries[]; // hits + misses (worker)
  caches: SystemSeries[]; // handler-layer cache sizes (server only)
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

  // CPU% / cpuCores: kernel-counted from process_cpu_{user,system}_seconds
  // deltas (gopsutil /proc/<pid>/stat) — same source kubectl top
  // uses. cpuCores = (procUser + procSys delta) / wallSec; CPU% =
  // cpuCores / NumCPU. NumCPU == GOMAXPROCS, which automaxprocs
  // sets from the cgroup CPU quota.
  //
  // cpuBreakdown lines (user / gc / scavenge / idle cores) DO use
  // runtime/metrics — that's the Go scheduler's per-class view, and
  // the chart is explicitly the "what the runtime is doing" lens.
  // Operator can see at a glance whether CPU is "real work" (user
  // climbs) or "GC pressure" (gc climbs).
  //
  // procVsGoCpu compares the kernel-counted total against runtime/
  // metrics' cpu_user_seconds (the runtime has no separate sys
  // line). They should track tightly; divergence usually means cgo
  // or cgroup throttling — i.e. the kernel sees CPU time that Go's
  // accounting can't attribute, and that's the actionable signal.
  const cpuPoints: { t: number; v: number }[] = [];
  const cpuCoresPoints: { t: number; v: number }[] = [];
  const cpuUserCores: { t: number; v: number }[] = [];
  const cpuGCCores: { t: number; v: number }[] = [];
  const cpuScavengeCores: { t: number; v: number }[] = [];
  const cpuIdleCores: { t: number; v: number }[] = [];
  const gcFreqPoints: { t: number; v: number }[] = [];
  const procCpuCores: { t: number; v: number }[] = [];
  const goCpuCores: { t: number; v: number }[] = [];
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1].runtime;
    const b = ring[i].runtime;
    const wallSec = (ts[i] - ts[i - 1]) / 1000;
    const userDelta = b.cpu_user_seconds - a.cpu_user_seconds;
    const gcDelta = b.cpu_gc_seconds - a.cpu_gc_seconds;
    const scavDelta = b.cpu_scavenge_seconds - a.cpu_scavenge_seconds;
    // CPU%: from kernel process counters, not runtime/metrics.
    // Latter excludes syscall waits, undercounting by ~10× on a
    // server doing mostly HTTP I/O. Cores consumed = (user+sys)/wall;
    // % is that against effective CPU count (NumCPU == GOMAXPROCS,
    // which automaxprocs sets from cgroup quota).
    const procUserDelta = b.process_cpu_user_seconds - a.process_cpu_user_seconds;
    const procSysDelta = b.process_cpu_system_seconds - a.process_cpu_system_seconds;
    const procCoresUsed = wallSec > 0 ? Math.max(0, (procUserDelta + procSysDelta) / wallSec) : 0;
    const numCPU = ring[i].identity.num_cpu || 1;
    cpuPoints.push({
      t: ts[i],
      v: Math.max(0, Math.min(100, (procCoresUsed / numCPU) * 100)),
    });
    cpuCoresPoints.push({ t: ts[i], v: procCoresUsed });
    // The per-class (user / gc / scavenge) cores breakdown below
    // still uses runtime/metrics — fine because it's labeled clearly
    // as the runtime's view, and the headline CPU% / cores series
    // above no longer relies on it.
    cpuUserCores.push({ t: ts[i], v: wallSec > 0 ? Math.max(0, userDelta / wallSec) : 0 });
    cpuGCCores.push({ t: ts[i], v: wallSec > 0 ? Math.max(0, gcDelta / wallSec) : 0 });
    cpuScavengeCores.push({
      t: ts[i],
      v: wallSec > 0 ? Math.max(0, scavDelta / wallSec) : 0,
    });
    const idleDelta = b.cpu_idle_seconds - a.cpu_idle_seconds;
    cpuIdleCores.push({
      t: ts[i],
      v: wallSec > 0 ? Math.max(0, idleDelta / wallSec) : 0,
    });
    // GC frequency = cycles per wall-second over the tick interval.
    const gcCyclesDelta = b.gc_cycles_total - a.gc_cycles_total;
    gcFreqPoints.push({
      t: ts[i],
      v: wallSec > 0 && gcCyclesDelta >= 0 ? gcCyclesDelta / wallSec : 0,
    });
    // Process vs Runtime CPU comparison chart: kernel (user+sys
    // from procUserDelta+procSysDelta computed above) plotted next
    // to Go runtime's user (only — runtime has no separate sys).
    procCpuCores.push({
      t: ts[i],
      v: procCoresUsed,
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
  const httpTotals = multi([
    {
      name: 'requests_total',
      get: (s) =>
        Number((s.custom?.http as { requests_total?: number } | undefined)?.requests_total) || 0,
    },
    {
      name: 'status_5xx_total',
      get: (s) =>
        Number((s.custom?.http as { status_5xx_total?: number } | undefined)?.status_5xx_total) || 0,
    },
  ]);
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
    {
      name: 'inference_total',
      get: (s) => Number((s.custom?.inference as { total?: number } | undefined)?.total) || 0,
    },
  ]);

  // Yamux totals (sessions + global stream count) — server only.
  const yamuxTotals = multi([
    { name: 'sessions', get: (s) => num(s.custom?.yamux, 'sessions') },
    { name: 'streams_open', get: (s) => num(s.custom?.yamux, 'streams_open') },
  ]);

  // DB pool. `max` is the configured upper bound (SetMaxOpenConns)
  // — plotted as a flat ceiling line so the operator can eyeball
  // saturation: when `in_use` is hugging `max` the pool is the
  // bottleneck and either MaxOpenConns needs raising or query
  // duration trimming.
  const dbPool = multi([
    {
      name: 'max',
      get: (s) =>
        Number(
          (s.custom?.db as { max_open_connections?: number } | undefined)?.max_open_connections,
        ) || 0,
    },
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
  // Connection eviction counters (cumulative). Both should be flat
  // under steady state; sudden climb = MaxIdleTime / MaxLifetime is
  // too aggressive for the workload.
  const dbClosed = multi([
    {
      name: 'max_idle_closed',
      get: (s) =>
        Number((s.custom?.db as { max_idle_closed?: number } | undefined)?.max_idle_closed) || 0,
    },
    {
      name: 'max_lifetime_closed',
      get: (s) =>
        Number(
          (s.custom?.db as { max_lifetime_closed?: number } | undefined)?.max_lifetime_closed,
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
  // Tunnel state (worker only): active stream count + reconnect
  // count over time + session uptime (seconds). A flapping tunnel
  // shows as reconnect_total stepping up + uptime sawtoothing.
  const tunnelState = multi([
    { name: 'streams_open', get: (s) => num(s.custom?.tunnel, 'streams_open') },
    { name: 'reconnect_total', get: (s) => num(s.custom?.tunnel, 'reconnect_total') },
    {
      name: 'session_uptime_min',
      get: (s) => num(s.custom?.tunnel, 'session_uptime_seconds') / 60,
    },
  ]);
  const routerHit = single('hit_rate', (s) => num(s.custom?.in_cluster_router, 'hit_rate'));
  const routerHits = multi([
    { name: 'hits', get: (s) => num(s.custom?.in_cluster_router, 'hits') },
    { name: 'misses', get: (s) => num(s.custom?.in_cluster_router, 'misses') },
  ]);

  // Server handler-layer caches (plugin URL resolver, per-cluster
  // reverse-proxy semaphores, VM response TTL cache). All small;
  // anomaly = "this should be 50 but it's 5000" suggests a leak.
  const caches = [
    {
      name: 'plugin_resolve',
      points: ring.map((s, i) => ({ t: ts[i], v: num(s.custom?.caches, 'plugin_resolve') })),
    },
    {
      name: 'proxy_semaphores',
      points: ring.map((s, i) => ({ t: ts[i], v: num(s.custom?.caches, 'proxy_semaphores') })),
    },
    {
      name: 'vm_response',
      points: ring.map((s, i) => ({ t: ts[i], v: num(s.custom?.caches, 'vm_response') })),
    },
  ];

  return {
    goroutines: single('goroutines', (s) => s.runtime.goroutines),
    heap: single('heap_inuse', (s) => s.runtime.heap_inuse_bytes),
    gcPause: multi([
      { name: 'p50', get: (s) => s.runtime.gc_pause_p50_seconds },
      { name: 'p90', get: (s) => s.runtime.gc_pause_p90_seconds },
      { name: 'p99', get: (s) => s.runtime.gc_pause_p99_seconds },
      { name: 'max', get: (s) => s.runtime.gc_pause_max_seconds },
    ]),
    gcFreq: [{ name: 'cycles/s', points: gcFreqPoints }],
    cpu: [{ name: 'busy %', points: cpuPoints }],
    cpuCores: [{ name: 'cores', points: cpuCoresPoints }],
    cpuBreakdown: [
      { name: 'user', points: cpuUserCores },
      { name: 'gc', points: cpuGCCores },
      { name: 'scavenge', points: cpuScavengeCores },
      { name: 'idle (scheduler)', points: cpuIdleCores },
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
      { name: 'mapped (total)', get: (s) => s.runtime.total_mapped_bytes },
    ]),
    // `rss` series feeds the "Memory usage" chart — plot working-set
    // so the line matches `kubectl top pod` exactly. Backend already
    // falls back working_set→rss when no cgroup, so this is safe on
    // bare-metal Linux / macOS / Windows too.
    rss: single('working set', (s) => s.runtime.working_set_bytes || s.runtime.rss_bytes),
    memPct: [
      {
        name: 'working set / total',
        points: ring.map((s, i) => {
          const used = s.runtime.working_set_bytes || s.runtime.rss_bytes;
          return {
            t: ts[i],
            v:
              s.runtime.mem_total_bytes > 0 && used > 0
                ? (used / s.runtime.mem_total_bytes) * 100
                : 0,
          };
        }),
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
    yamuxTotals,
    httpRPS,
    httpTotals,
    httpLatency,
    httpInflight,
    sseInference,
    dbPool,
    dbWait,
    dbClosed,
    proxyInflight,
    tunnelState,
    routerHit,
    routerHits,
    caches,
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
    gcFreq: [],
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
    yamuxTotals: [],
    httpRPS: [],
    httpTotals: [],
    httpLatency: [],
    httpInflight: [],
    sseInference: [],
    dbPool: [],
    dbWait: [],
    dbClosed: [],
    proxyInflight: [],
    tunnelState: [],
    routerHit: [],
    routerHits: [],
    caches: [],
  };
}
