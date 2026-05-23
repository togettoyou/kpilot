import {
  ClearOutlined,
  DownloadOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  PlayCircleOutlined,
  SearchOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useIntl, useParams } from '@umijs/max';
import {
  Alert,
  Button,
  Card,
  Col,
  Dropdown,
  Empty,
  Input,
  Result,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useThemeMode } from 'antd-style';
import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Virtuoso } from 'react-virtuoso';

import TimeRangePicker, {
  resolveTimeRange,
  type TimeRangeValue,
} from '@/components/TimeRangePicker';
import {
  isResourceNotAvailable,
  NotInstalled,
} from '@/pages/Compute/Volcano/shared/Layout';
import {
  type LogLine,
  logsHistogram,
  type LogsHistogramResponse,
  type LogsResult,
  streamLogsSearch,
} from '@/services/kpilot/logs';
import {
  getWorkload,
  listNamespaces,
  listWorkloads,
} from '@/services/kpilot/workload';

import LogsQLHelp from './LogsQLHelp';
import {
  composeStreamSelector,
  escapeRegex,
  extractHighlightTerms,
  mergeStreamSelector,
} from './queryUtils';

// Heavy chart split off to keep the cluster-detail bundle lean.
const LoggingHistogram = lazy(() => import('./LoggingHistogram'));

// triggerDownload pipes a string blob into a browser download. Pure
// client-side — the log lines are already in memory, no second server
// round-trip needed. Revokes the object URL after the synthetic click
// to free the blob; the click is dispatched synchronously so the URL
// is still resolvable when the browser starts the download.
function triggerDownload(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Firefox / Safari finish queuing the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// formatTxt renders the lines as one human-readable row each. Mirrors
// the on-screen layout: `<time>  [ns/pod/container]  <message>`.
// Synchronous string build — at 10k × ~200 bytes/row = ~2 MiB, well
// under any "too slow" threshold.
function formatTxt(lines: LogLine[]): string {
  return lines
    .map((ln) => {
      const ts = ln.time;
      const tags = [ln.namespace, ln.pod, ln.container]
        .filter(Boolean)
        .join('/');
      const prefix = tags ? `${ts}\t[${tags}]\t` : `${ts}\t`;
      return prefix + (ln.message ?? '');
    })
    .join('\n');
}

// formatNdjson — one JSON object per line, the canonical shape for
// downstream log processing tools (jq, vector, etc.). Keeps the full
// `fields` map intact, unlike the TXT projection.
function formatNdjson(lines: LogLine[]): string {
  return lines.map((ln) => JSON.stringify(ln)).join('\n');
}

// /clusters/:id/logging — self-rendered search UI for VictoriaLogs.
// Three pieces visible above the fold: the query bar (LogsQL string),
// the volume histogram, and the matching log lines. The histogram and
// the search fire in parallel against two server handlers; the user
// hits 「搜索」 (or presses Enter in the query box) to issue a new
// request.
//
// LIMIT_TIERS — fixed step ladder for the limit dropdown. Beats a
// free-form Input because users would silently lose typed values >
// 50000 (the server cap); now they pick a value that's always valid.
const LIMIT_TIERS = [100, 500, 1000, 5000, 10000, 50000];

const LoggingPage: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const { isDarkMode } = useThemeMode();

  // Empty default — the backend treats "" as "*" so a fresh page can
  // hit Search and see all logs in the window. Removes the magic
  // asterisk users had to know to wipe before typing.
  const [query, setQuery] = useState('');
  const [range, setRange] = useState<TimeRangeValue>({
    mode: 'preset',
    preset: '1h',
  });
  const [limit, setLimit] = useState(200);
  // Histogram is collapsed by default — gives the results region the
  // most vertical room out of the box. The title row still shows the
  // total-matches count so the "is this query hitting?" signal is
  // visible without opening the chart; toggle to expand on demand.
  const [showHistogram, setShowHistogram] = useState(false);
  // Measure the actual available viewport height after mount. The old
  // static calc(100vh - 56px) didn't account for ProLayout's content
  // padding so the page overflowed by a few pixels, producing an outer
  // scrollbar even before the first search. Same pattern GrafanaEmbed
  // uses — getBoundingClientRect().top gives the exact top offset that
  // 100vh - top fills.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [containerHeight, setContainerHeight] = useState<number | null>(null);
  // Fullscreen / "max" mode for the results — hides the entire query
  // bar + histogram and gives the log list the whole viewport. Useful
  // when scrolling through a large result set or projecting on a
  // big screen. Esc exits.
  const [fullscreen, setFullscreen] = useState(false);

  // Structured pickers — convenience layer that auto-builds a LogsQL
  // stream selector and back-fills it into the input. The input
  // remains source-of-truth; once the user edits it manually the
  // pickers don't reach back in.
  const [pickerNs, setPickerNs] = useState('');
  const [pickerPod, setPickerPod] = useState('');
  const [pickerContainer, setPickerContainer] = useState('');
  const [nsList, setNsList] = useState<string[]>([]);
  const [nsLoading, setNsLoading] = useState(false);
  const [podList, setPodList] = useState<string[]>([]);
  const [podLoading, setPodLoading] = useState(false);
  const [containerList, setContainerList] = useState<string[]>([]);
  const [containerLoading, setContainerLoading] = useState(false);
  // submitted{Query,Range,Limit,Anchor} = the params backing the
  // currently-displayed results. We update them on submit so editing
  // the query doesn't immediately reflow the chart underneath.
  const [submitted, setSubmitted] = useState<{
    query: string;
    range: TimeRangeValue;
    limit: number;
  } | null>(null);

  // 流式 + 直方图状态:lines 用单独的 useState 持续 append(streaming
  // path),search.summary 在结果事件到达后填充。直方图是非流式独立请求。
  // 不用 useClusterRequest 因为 logging 不该一进页面就跑大查询,
  // 用户敲 Enter 才发。
  const [lines, setLines] = useState<LogLine[]>([]);
  const [search, setSearch] = useState<{
    summary: LogsResult | null;
    error: any;
    loading: boolean;
    elapsedMs: number;
  }>({ summary: null, error: null, loading: false, elapsedMs: 0 });
  const [histo, setHisto] = useState<{
    data: LogsHistogramResponse | null;
    loading: boolean;
  }>({ data: null, loading: false });

  // AbortController for the in-flight stream — Stop button calls
  // abort(); switching cluster also aborts so a half-loaded result
  // doesn't bleed into the next cluster's view.
  const abortRef = useRef<AbortController | null>(null);
  // Live tail state. When `liveMode` is on, a polling loop keeps
  // fetching logs starting from the timestamp of the last received
  // line. The time-range picker is hidden + the histogram doesn't
  // fire while live tail is active.
  const [liveMode, setLiveMode] = useState(false);
  // Mutable flag the polling loop checks each iteration — needs to
  // be a ref so the loop sees the latest value across closures.
  const liveActiveRef = useRef(false);
  // Latest log timestamp seen so far; used as exclusive lower bound
  // for the next poll. null = first iteration → start from "30 s
  // ago" so the user sees a tiny seed history immediately on toggle.
  const lastLineTimeRef = useRef<string | null>(null);
  // Wall-clock start of the current query (or last completed one),
  // captured at runQuery start so a 200 ms ticker can derive
  // elapsedMs LIVE without waiting for the server's 25 s `progress`
  // heartbeat. Without this the caption is stuck at 0.0s for any
  // sub-25-second query (i.e. most of them).
  const startRef = useRef<number | null>(null);

  const runQuery = useCallback(
    async (overrideRange?: TimeRangeValue | unknown) => {
    if (!clusterId) return;
    // If a previous stream is still going, abort it before starting
    // a new one (user mashed Enter / Search rapidly).
    abortRef.current?.abort();

    // Empty input → ask for everything. Backend mirrors this default
    // so the server-side LogsQL parser sees `*` even on first load.
    const q = query.trim() || '*';
    // Accept an optional override so histogram zoom can hand in a
    // range that hasn't yet propagated through setState. Event
    // handlers (Enter / button click) pass their event object as
    // arg-0; type-guard for the discriminator key so we don't try
    // to resolve a KeyboardEvent as a range.
    const isRange =
      overrideRange != null &&
      typeof overrideRange === 'object' &&
      'mode' in (overrideRange as Record<string, unknown>);
    const effectiveRange = isRange
      ? (overrideRange as TimeRangeValue)
      : range;
    const { from: fromDate, to: toDate } = resolveTimeRange(effectiveRange);
    const from = fromDate.toISOString();
    const to = toDate.toISOString();
    setSubmitted({ query: q, range: effectiveRange, limit });

    // Reset stream-derived state before kicking off a new run.
    setLines([]);
    startRef.current = Date.now();
    setSearch({
      summary: null,
      error: null,
      loading: true,
      elapsedMs: 0,
    });
    setHisto({ data: null, loading: true });

    const controller = new AbortController();
    abortRef.current = controller;

    // Parallel — histogram is independent of streaming search.
    void logsHistogram(clusterId, { query: q, from, to }).then(
      (data) => setHisto({ data, loading: false }),
      () => setHisto({ data: null, loading: false }),
    );

    try {
      const summary = await streamLogsSearch(
        clusterId,
        { query: q, from, to, limit },
        {
          // onLine receives batched arrays (50ms / 100-row windows)
          // so concat-into-state happens at most ~20×/sec —
          // virtuoso handles that comfortably.
          onLine: (batch) =>
            setLines((prev) => {
              if (batch.length === 0) return prev;
              const next = prev.slice();
              for (const ln of batch) next.push(ln);
              return next;
            }),
          // onProgress intentionally omitted — server's 25 s
          // heartbeat is too coarse for a live caption. The
          // 200 ms wall-clock ticker below updates elapsedMs
          // from Date.now() instead, and works even when the
          // query is so fast no progress event ever arrives.
        },
        { signal: controller.signal },
      );
      // Identity-check the controller before writing state: a
      // newer runQuery may have aborted us and started its own
      // stream. Without this check, the stale resolve/reject of
      // an older run clobbers the newer run's state (loading flag
      // flickers off, summary disappears, etc.). The finally
      // block does the same check for abortRef cleanup.
      if (abortRef.current !== controller) return;
      setSearch({
        summary,
        error: null,
        loading: false,
        elapsedMs: summary.elapsedMs,
      });
    } catch (e: any) {
      if (abortRef.current !== controller) return;
      // AbortError = user clicked Stop. Keep whatever streamed so
      // far, just flip loading off — don't surface as an error.
      if (e instanceof DOMException && e.name === 'AbortError') {
        setSearch((prev) => ({ ...prev, loading: false }));
      } else {
        setSearch({
          summary: null,
          error: e,
          loading: false,
          elapsedMs: 0,
        });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  },
    [clusterId, query, range, limit],
  );

  // Stop button — abort the in-flight stream. Lines already
  // displayed stay; summary stays null so the truncation banner
  // doesn't fire spuriously. Also stops live tail if running.
  const onStop = useCallback(() => {
    liveActiveRef.current = false;
    setLiveMode(false);
    abortRef.current?.abort();
  }, []);

  // Live tail polling loop. setTimeout chains each iteration after
  // the previous one resolves so we never overlap a slow fetch with
  // a new one. The poll window is from = max(seen line time, now -
  // 30 s) to now, with a per-iter limit of 500 lines. That's a
  // sensible cap for a single pod's burst (kubelet streams ~hundreds
  // of lines/sec on noisy services), but high enough that everyday
  // chatter rarely hits it.
  const livePoll = useCallback(async () => {
    if (!liveActiveRef.current || !clusterId) return;
    const now = new Date();
    const fromMs = lastLineTimeRef.current
      ? // 1 ms past the last seen line — VL `start` is inclusive,
        // so we'd otherwise re-receive the same line on every tick.
        new Date(lastLineTimeRef.current).getTime() + 1
      : now.getTime() - 30_000;
    const from = new Date(fromMs).toISOString();
    const to = now.toISOString();
    const q = query.trim() || '*';
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamLogsSearch(
        clusterId,
        { query: q, from, to, limit: 500 },
        {
          onLine: (batch) =>
            setLines((prev) => {
              if (batch.length === 0) return prev;
              // Live tail: newest line sits at the top, like
              // most log UIs (Datadog, Lens, vmlogs UI). VL
              // returns the batch newest-first within itself
              // (default _time desc), so prepending the batch
              // verbatim keeps both intra-batch ordering AND
              // global-newest-first across polls.
              const next = [...batch, ...prev];
              // Track the newest timestamp for the next poll's
              // exclusive lower bound. batch[0] is the newest
              // in this round; only advance if it really IS
              // newer than what we've seen (defensive against
              // an empty time field).
              const newest = batch[0]?.time;
              if (
                newest &&
                (!lastLineTimeRef.current ||
                  newest > lastLineTimeRef.current)
              ) {
                lastLineTimeRef.current = newest;
              }
              return next;
            }),
        },
        { signal: controller.signal },
      );
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return; // stop pressed mid-iter
      }
      // Non-abort errors — log and keep trying. Transient VL hiccups
      // shouldn't tear down the live tail; a persistent failure
      // shows up as "no new rows" and the user can hit Stop.
      // eslint-disable-next-line no-console
      console.warn('[live-tail] iter failed', e);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
    if (liveActiveRef.current) {
      setTimeout(livePoll, 2000);
    }
  }, [clusterId, query]);

  const startLiveTail = useCallback(() => {
    if (liveActiveRef.current) return;
    // Cancel any in-flight manual search before flipping into live.
    abortRef.current?.abort();
    liveActiveRef.current = true;
    setLiveMode(true);
    // Clear the panel so the user sees only freshly-tailing rows.
    setLines([]);
    lastLineTimeRef.current = null;
    setSubmitted({
      query: query.trim() || '*',
      // Range field is meaningless in live mode (we override per
      // iteration); keep the current value so toggling off restores
      // the user's last picker selection.
      range,
      limit: 500,
    });
    setHisto({ data: null, loading: false });
    setSearch({
      summary: null,
      error: null,
      loading: false,
      elapsedMs: 0,
    });
    livePoll();
  }, [livePoll, query, range]);

  const stopLiveTail = useCallback(() => {
    liveActiveRef.current = false;
    setLiveMode(false);
    abortRef.current?.abort();
  }, []);

  // onReset — restore the page to its first-paint state. Useful
  // when the user has chained filters / picked a pod / left live
  // tail running and wants a fresh start without re-navigating.
  // Stops any in-flight stream + live tail, clears query / range /
  // limit / pickers / results, and wipes the URL.
  const onReset = useCallback(() => {
    liveActiveRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    setLiveMode(false);
    setQuery('');
    setRange({ mode: 'preset', preset: '1h' });
    setLimit(200);
    setPickerNs('');
    setPickerPod('');
    setPickerContainer('');
    setSubmitted(null);
    setLines([]);
    setSearch({ summary: null, error: null, loading: false, elapsedMs: 0 });
    setHisto({ data: null, loading: false });
    setShowHistogram(false);
    lastLineTimeRef.current = null;
    // Drop URL params so a copied link reflects the cleared page.
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  // Tear down live tail on unmount / cluster switch.
  useEffect(() => {
    return () => {
      liveActiveRef.current = false;
    };
  }, []);

  // Highlight terms come from the SUBMITTED query (not the live input)
  // so the highlights match what was actually searched — editing the
  // input shouldn't make the displayed lines flicker.
  const highlightTerms = useMemo(
    () => extractHighlightTerms(submitted?.query ?? ''),
    [submitted],
  );

  // Fetch the namespace list once per cluster for the structured
  // picker. Same pattern as Monitoring page — local state, not the
  // global namespace model.
  useEffect(() => {
    if (!clusterId) return;
    let cancelled = false;
    setNsLoading(true);
    listNamespaces(clusterId)
      .then((list) => {
        if (!cancelled) setNsList(list ?? []);
      })
      .catch(() => {
        if (!cancelled) setNsList([]);
      })
      .finally(() => {
        if (!cancelled) setNsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clusterId]);

  // Pods list depends on the picked namespace. Reset and refetch
  // whenever ns changes. Cluster-wide pod listing (ns="") is skipped
  // — large clusters would balloon the dropdown — so a user has to
  // pick a namespace before the pod picker becomes useful.
  useEffect(() => {
    setPickerPod('');
    setPodList([]);
    if (!clusterId || !pickerNs) return;
    let cancelled = false;
    setPodLoading(true);
    listWorkloads(clusterId, 'pods', pickerNs, 500, '')
      .then((res) => {
        if (cancelled) return;
        // Worker requests the K8s Table representation
        // (`application/json;as=Table`), so the response shape is
        // `{kind:'Table', rows:[{object:{metadata:{name}}, cells}]}`
        // — not a plain List with `.items`. Pull names from row
        // metadata; the cells[] fallback covers Tables that ship a
        // PartialObjectMetadata stripped to just labels.
        const rows = (res?.rows ?? []) as Array<{
          object?: { metadata?: { name?: string } };
          cells?: unknown[];
        }>;
        const colNames = ((res?.columnDefinitions ?? []) as Array<{
          name?: string;
        }>).map((c) => c.name ?? '');
        const nameIdx = colNames.indexOf('Name');
        const names = rows
          .map((r) => {
            const fromMeta = r.object?.metadata?.name;
            if (fromMeta) return fromMeta;
            if (nameIdx >= 0) {
              const v = r.cells?.[nameIdx];
              if (typeof v === 'string') return v;
            }
            return '';
          })
          .filter((n) => !!n)
          .sort();
        setPodList(names);
      })
      .catch(() => {
        if (!cancelled) setPodList([]);
      })
      .finally(() => {
        if (!cancelled) setPodLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clusterId, pickerNs]);

  // Picker change → swap the LEADING stream selector in the query,
  // keep everything else. mergeStreamSelector handles the three
  // cases (no selector / leading selector / cleared selector) so
  // free-text terms the user typed survive picking a namespace.
  const onPickerChange = (
    nextNs: string,
    nextPod: string,
    nextContainer: string,
  ) => {
    setPickerNs(nextNs);
    setPickerPod(nextPod);
    setPickerContainer(nextContainer);
    setQuery((prev) =>
      mergeStreamSelector(
        prev,
        composeStreamSelector(nextNs, nextPod, nextContainer),
      ),
    );
  };

  // Fetch the container list whenever the picked pod changes. Spec
  // has both `containers` and `initContainers`; init containers also
  // produce stream logs Vector picks up, so we include both. Clearing
  // the pod resets the container Select.
  useEffect(() => {
    setPickerContainer('');
    setContainerList([]);
    if (!clusterId || !pickerNs || !pickerPod) return;
    let cancelled = false;
    setContainerLoading(true);
    getWorkload(clusterId, 'pods', pickerPod, pickerNs)
      .then((pod: any) => {
        if (cancelled) return;
        const containers = (pod?.spec?.containers ?? []) as Array<{
          name?: string;
        }>;
        const inits = (pod?.spec?.initContainers ?? []) as Array<{
          name?: string;
        }>;
        const names = [...containers, ...inits]
          .map((c) => c.name ?? '')
          .filter((n) => !!n)
          .sort();
        setContainerList(names);
      })
      .catch(() => {
        if (!cancelled) setContainerList([]);
      })
      .finally(() => {
        if (!cancelled) setContainerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clusterId, pickerNs, pickerPod]);

  // URL ⇄ state sync. On mount, deserialise ?q=&from=&to=&… into the
  // editable controls. After every submit, serialise back so a copy-
  // pasted URL reproduces the same view. Keystrokes don't update the
  // URL — too noisy in browser history; the user has to hit search
  // (or live-tail-on) to commit a URL.
  //
  // Mount-read uses window.location.search directly rather than
  // useSearchParams so the initial state is captured before the
  // first paint — useSearchParams + useEffect would mean a one-
  // tick flash of defaults before URL state lands.
  useEffect(() => {
    if (!clusterId) return;
    const sp = new URLSearchParams(window.location.search);
    const q = sp.get('q');
    if (q !== null) setQuery(q);
    const rangeKey = sp.get('range');
    const from = sp.get('from');
    const to = sp.get('to');
    const sinceNow = sp.get('sinceNow');
    if (rangeKey === '1h' || rangeKey === '24h' || rangeKey === '7d' || rangeKey === '30d') {
      setRange({ mode: 'preset', preset: rangeKey });
    } else if (from && to) {
      const f = new Date(from);
      const t = new Date(to);
      if (!Number.isNaN(f.getTime()) && !Number.isNaN(t.getTime())) {
        setRange({ mode: 'custom', from: f, to: t });
      }
    } else if (from && sinceNow === '1') {
      const f = new Date(from);
      if (!Number.isNaN(f.getTime())) setRange({ mode: 'sinceNow', from: f });
    }
    const lim = sp.get('limit');
    if (lim) {
      const v = parseInt(lim, 10);
      if (!Number.isNaN(v) && v > 0) setLimit(v);
    }
    const ns = sp.get('ns');
    const pod = sp.get('pod');
    const container = sp.get('container');
    if (ns) setPickerNs(ns);
    if (pod) setPickerPod(pod);
    if (container) setPickerContainer(container);
    // If the URL carried a query (any of the search-defining
    // params), auto-run so the user gets the page they linked
    // to without an extra click. Skip when only picker params
    // exist — those alone don't constitute a "go look at this".
    if (q || rangeKey || (from && to) || lim) {
      // Defer one tick so setState above has committed.
      setTimeout(() => runQueryRef.current?.(), 0);
    }
    // Run once per cluster — subsequent URL changes are
    // outgoing (writeUrl below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  // runQueryRef lets the URL-hydration effect call the latest
  // runQuery without listing it as a dep (which would re-fire on
  // every range/query/limit change and turn this from "hydrate
  // once" into "hydrate every render").
  const runQueryRef = useRef<((r?: TimeRangeValue) => Promise<void>) | null>(
    null,
  );
  useEffect(() => {
    runQueryRef.current = runQuery as any;
  }, [runQuery]);

  // URL write — fires whenever a submit lands or a picker changes.
  // history.replaceState rather than pushState so back button still
  // goes to the previous PAGE, not to "same page minus filter".
  useEffect(() => {
    if (!clusterId) return;
    const sp = new URLSearchParams();
    if (submitted?.query && submitted.query !== '*') {
      sp.set('q', submitted.query);
    }
    if (submitted?.range) {
      const r = submitted.range;
      if (r.mode === 'preset') {
        sp.set('range', r.preset);
      } else if (r.mode === 'custom') {
        sp.set('from', r.from.toISOString());
        sp.set('to', r.to.toISOString());
      } else if (r.mode === 'sinceNow') {
        sp.set('from', r.from.toISOString());
        sp.set('sinceNow', '1');
      }
    }
    if (submitted?.limit && submitted.limit !== 200) {
      sp.set('limit', String(submitted.limit));
    }
    if (pickerNs) sp.set('ns', pickerNs);
    if (pickerPod) sp.set('pod', pickerPod);
    if (pickerContainer) sp.set('container', pickerContainer);
    const qs = sp.toString();
    const next = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, '', next);
    }
  }, [clusterId, submitted, pickerNs, pickerPod, pickerContainer]);

  // Lightweight install probe on mount — fires a tiny histogram query
  // over the last minute. RESOURCE_NOT_AVAILABLE surfaces immediately
  // so the page renders the shared NotInstalled hint without forcing
  // the user to type a query first. Any other error (or success) is
  // ignored: the page falls through to the empty query bar.
  useEffect(() => {
    if (!clusterId) return;
    let cancelled = false;
    const nowMs = Date.now();
    logsHistogram(clusterId, {
      query: '*',
      from: new Date(nowMs - 60_000).toISOString(),
      to: new Date(nowMs).toISOString(),
    }).catch((error) => {
      if (cancelled) return;
      if (isResourceNotAvailable(error)) {
        setSearch({
          summary: null,
          error,
          loading: false,
          elapsedMs: 0,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [clusterId]);

  // Abort any in-flight stream when the page unmounts or the cluster
  // switches — otherwise the EventSource keeps running in the
  // background even though no one is consuming it.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Wall-clock ticker for the live elapsed caption. Runs only while
  // a query is in flight; updates search.elapsedMs every 200 ms from
  // Date.now() - startRef.current. Server's `progress` event only
  // fires every 25 s so it's useless for sub-25 s queries, which
  // is most of them. After completion, search.elapsedMs is snapped
  // to the server-reported summary.elapsedMs in the success path
  // (slightly more accurate; ignores our wall-clock estimate).
  useEffect(() => {
    if (!search.loading || startRef.current === null) return;
    const id = setInterval(() => {
      const start = startRef.current;
      if (start === null) return;
      const now = Date.now();
      setSearch((prev) => {
        if (!prev.loading) return prev;
        return { ...prev, elapsedMs: now - start };
      });
    }, 200);
    return () => clearInterval(id);
  }, [search.loading]);

  // Page-switch scroll reset. The logging page is fixed-viewport:
  // wrapper height is computed from getBoundingClientRect().top,
  // which is itself relative to the nearest scroll container. If
  // the user scrolled the previous page (e.g. /monitoring is a
  // tall, scrollable list), the ProLayout content area retains
  // that scrollTop on navigation — our wrapper.top ends up
  // negative and the page renders shifted out of view.
  //
  // Walk up from the wrapper resetting every scrollable ancestor
  // we find, plus window itself. window.scrollTo covers the case
  // where the document body is what scrolled.
  useEffect(() => {
    window.scrollTo(0, 0);
    let el: HTMLElement | null = wrapperRef.current;
    // wrapperRef is null on first render — defer one frame.
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

  // Wrapper height = viewport - wrapper.top - footer.height - (gap
  // between wrapper bottom and footer top). The gap is a CONSTANT
  // determined by ProLayout's content padding / margins, but it isn't
  // a stable selector we can hardcode — measure it directly as
  // (footer.top - wrapper.bottom). The gap stays the same whether
  // the wrapper is too tall (footer pushed below viewport) or
  // perfectly sized, so a single measurement converges. rAF-throttled
  // to survive sider-drag's body-ResizeObserver spam.
  //
  // Previous attempts that subtracted document overflow on top of
  // footer.offsetHeight double-counted (overflow already contained
  // the footer's height) and the wrapper shrank by 2 × footer + gap
  // — the page looked roughly right but the convergence flipped on
  // each tick. This formula is closed-form: every term is a constant
  // of the layout, no feedback loop.
  useEffect(() => {
    let pending = 0;
    const measure = () => {
      pending = 0;
      const el = wrapperRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Footer renders as <div className="kpilot-footer"> via
      // app.tsx's footerRender → Footer component. ProLayout doesn't
      // wrap footerRender output in an .ant-layout-footer, so we
      // tagged Footer with a stable class instead.
      const footer = document.querySelector<HTMLElement>('.kpilot-footer');
      if (!footer) {
        // No footer (login page etc) — just fill to viewport bottom.
        const h = Math.max(0, Math.floor(window.innerHeight - rect.top));
        setContainerHeight((prev) => (prev === h ? prev : h));
        return;
      }
      const footerRect = footer.getBoundingClientRect();
      // Gap between wrapper bottom and footer top is the constant we
      // can't enumerate (content-area padding, layout margins, etc.).
      // Works even when the footer is currently pushed below viewport
      // because the gap is independent of where each element ends up.
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

  // Esc exits fullscreen — global keydown listener while fullscreen
  // is active. Skips if user is typing in the query input (Esc would
  // otherwise blur via antd Input which the user probably wants for
  // dismissing the cursor, not the layout).
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        setFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  // Build the export menu (TXT / NDJSON). Filename includes the
  // cluster id + a timestamp so multi-cluster operators don't end up
  // with overwritten downloads.
  const onExport = useCallback(
    (format: 'txt' | 'ndjson') => {
      if (!lines.length) return;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const ext = format === 'txt' ? 'log' : 'ndjson';
      const filename = `kpilot-logs-${clusterId}-${ts}.${ext}`;
      const content =
        format === 'txt' ? formatTxt(lines) : formatNdjson(lines);
      const mime = format === 'txt' ? 'text/plain' : 'application/x-ndjson';
      triggerDownload(filename, content, mime);
    },
    [clusterId, lines],
  );

  if (!clusterId) return null;
  if (search.error && isResourceNotAvailable(search.error)) {
    return (
      <NotInstalled
        clusterId={clusterId}
        titleId="pages.logging.notInstalled.title"
        subTitleId="pages.logging.notInstalled.subTitle"
        actionId="pages.logging.notInstalled.action"
      />
    );
  }

  return (
    // Grafana-style fixed-viewport layout. Outer flex column locked to
    // the wrapper's actual available height (measured via ResizeObserver
    // above) so ProLayout's content padding never produces an outer
    // scrollbar. The static `calc(100vh - 56px)` fallback covers the
    // first render before the measure useEffect runs.
    <div
      ref={wrapperRef}
      style={{
        height: containerHeight != null ? containerHeight : 'calc(100vh - 56px)',
        display: 'flex',
        flexDirection: 'column',
        // Compact paddings/gaps — every px above the results card
        // is a px the results card doesn't have. Inputs and picker
        // chips are still comfortably tappable.
        padding: 8,
        gap: 6,
        overflow: 'hidden',
      }}
    >
      {!fullscreen && (
      <Space direction="vertical" size={6} style={{ width: '100%', flexShrink: 0 }}>
        {/* Query bar */}
        <Card size="small" styles={{ body: { padding: 12 } }}>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Input
              prefix={<SearchOutlined />}
              size="middle"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onPressEnter={runQuery}
              placeholder={intl.formatMessage({
                id: 'pages.logging.query.placeholder',
              })}
              allowClear
              // Quick "show me valid LogsQL" entry-point. Snippet
              // click replaces the current query — same trade-off as
              // a code-completion accept; user can edit afterwards.
              suffix={<LogsQLHelp onInsert={(s) => setQuery(s)} />}
            />
            {/* Structured pickers — auto-build a LogsQL stream selector
                from namespace + pod and back-fill the input above. Pod
                list is scoped to the picked namespace; picking nothing
                clears the selector and the input. */}
            <Row gutter={[8, 6]} align="middle" wrap>
              <Col>
                <Typography.Text type="secondary">
                  {intl.formatMessage({ id: 'pages.logging.picker.namespace' })}
                </Typography.Text>
              </Col>
              <Col>
                <Select
                  size="small"
                  style={{ width: 200 }}
                  allowClear
                  showSearch
                  loading={nsLoading}
                  placeholder={intl.formatMessage({
                    id: 'pages.logging.picker.namespace.placeholder',
                  })}
                  value={pickerNs || undefined}
                  onChange={(v) => onPickerChange(v ?? '', '', '')}
                  options={nsList.map((n) => ({ label: n, value: n }))}
                  filterOption={(input, opt) =>
                    (opt?.label as string)
                      ?.toLowerCase()
                      .includes(input.trim().toLowerCase())
                  }
                />
              </Col>
              <Col>
                <Typography.Text type="secondary">
                  {intl.formatMessage({ id: 'pages.logging.picker.pod' })}
                </Typography.Text>
              </Col>
              <Col>
                <Select
                  size="small"
                  style={{ width: 280 }}
                  allowClear
                  showSearch
                  loading={podLoading}
                  disabled={!pickerNs}
                  placeholder={intl.formatMessage({
                    id: pickerNs
                      ? 'pages.logging.picker.pod.placeholder'
                      : 'pages.logging.picker.pod.pickNsFirst',
                  })}
                  value={pickerPod || undefined}
                  onChange={(v) => onPickerChange(pickerNs, v ?? '', '')}
                  options={podList.map((n) => ({ label: n, value: n }))}
                  filterOption={(input, opt) =>
                    (opt?.label as string)
                      ?.toLowerCase()
                      .includes(input.trim().toLowerCase())
                  }
                />
              </Col>
              <Col>
                <Typography.Text type="secondary">
                  {intl.formatMessage({ id: 'pages.logging.picker.container' })}
                </Typography.Text>
              </Col>
              <Col>
                <Select
                  size="small"
                  style={{ width: 220 }}
                  allowClear
                  showSearch
                  loading={containerLoading}
                  disabled={!pickerPod}
                  placeholder={intl.formatMessage({
                    id: pickerPod
                      ? 'pages.logging.picker.container.placeholder'
                      : 'pages.logging.picker.container.pickPodFirst',
                  })}
                  value={pickerContainer || undefined}
                  onChange={(v) =>
                    onPickerChange(pickerNs, pickerPod, v ?? '')
                  }
                  options={containerList.map((n) => ({
                    label: n,
                    value: n,
                  }))}
                  filterOption={(input, opt) =>
                    (opt?.label as string)
                      ?.toLowerCase()
                      .includes(input.trim().toLowerCase())
                  }
                />
              </Col>
            </Row>
            {/* Scope controls on the left, action buttons on the
                right — one row when there's space, wraps gracefully
                on narrow viewports. flex="auto" spacer between the
                two halves keeps the actions pinned right. */}
            <Row gutter={[8, 6]} align="middle" wrap>
              <Col>
                <Typography.Text type="secondary">
                  {intl.formatMessage({ id: 'pages.logging.range' })}
                </Typography.Text>
              </Col>
              <Col>
                <TimeRangePicker value={range} onChange={setRange} />
              </Col>
              <Col>
                <Typography.Text type="secondary">
                  {intl.formatMessage({ id: 'pages.logging.limit' })}
                </Typography.Text>
              </Col>
              <Col>
                <Select
                  size="small"
                  style={{ width: 120 }}
                  value={limit}
                  onChange={(v) => setLimit(v)}
                  options={LIMIT_TIERS.map((n) => ({
                    label: n.toLocaleString(),
                    value: n,
                  }))}
                />
              </Col>
              <Col flex="auto" />
              <Col>
                <Space size={6}>
                  {/* All three actions are Buttons with the same
                      size so heights / corner radii line up.
                      Live tail is a toggle button (primary when
                      active) — the original antd Switch sat a
                      few px taller and broke the row baseline. */}
                  <Tooltip
                    title={intl.formatMessage({
                      id: 'pages.logging.live.tooltip',
                    })}
                  >
                    <Button
                      size="small"
                      type={liveMode ? 'primary' : 'default'}
                      icon={<PlayCircleOutlined />}
                      onClick={() =>
                        liveMode ? stopLiveTail() : startLiveTail()
                      }
                    >
                      {intl.formatMessage({
                        id: liveMode
                          ? 'pages.logging.live.on'
                          : 'pages.logging.live.off',
                      })}
                    </Button>
                  </Tooltip>
                  {liveMode || search.loading ? (
                    <Button
                      size="small"
                      danger
                      icon={<StopOutlined />}
                      onClick={onStop}
                    >
                      {intl.formatMessage({ id: 'pages.logging.stop' })}
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      type="primary"
                      icon={<SearchOutlined />}
                      onClick={runQuery}
                    >
                      {intl.formatMessage({ id: 'pages.logging.search' })}
                    </Button>
                  )}
                  <Tooltip
                    title={intl.formatMessage({
                      id: 'pages.logging.reset.tooltip',
                    })}
                  >
                    <Button
                      size="small"
                      icon={<ClearOutlined />}
                      onClick={onReset}
                    />
                  </Tooltip>
                </Space>
              </Col>
            </Row>
          </Space>
        </Card>

        {/* Histogram — collapsed by default. Title row stays visible
            (showing the total-matches count) so the user can see at a
            glance that the query did hit something even without
            opening the chart. */}
        {submitted && (
          <Card
            size="small"
            title={
              <Space>
                <Typography.Text strong>
                  {intl.formatMessage({ id: 'pages.logging.histogram.title' })}
                </Typography.Text>
                {histo.data && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {intl.formatMessage(
                      { id: 'pages.logging.histogram.total' },
                      { n: histo.data.total },
                    )}
                  </Typography.Text>
                )}
              </Space>
            }
            extra={
              <Button
                type="link"
                size="small"
                onClick={() => setShowHistogram((v) => !v)}
              >
                {intl.formatMessage({
                  id: showHistogram
                    ? 'pages.logging.histogram.hide'
                    : 'pages.logging.histogram.show',
                })}
              </Button>
            }
            styles={{ body: { padding: showHistogram ? 8 : 0 } }}
          >
            {showHistogram && (
              <Spin spinning={histo.loading}>
                <Suspense
                  fallback={
                    <div style={{ textAlign: 'center', padding: 16 }}>
                      <Spin />
                    </div>
                  }
                >
                  <LoggingHistogram
                    points={histo.data?.points ?? []}
                    dark={isDarkMode}
                    stepSeconds={histo.data?.stepSeconds ?? 60}
                    onZoom={(from, to) => {
                      // Drop into custom range mode anchored to the
                      // clicked bin AND re-run with the explicit
                      // range so the search doesn't have to wait
                      // for setState to propagate.
                      const zoomed: TimeRangeValue = {
                        mode: 'custom',
                        from,
                        to,
                      };
                      setRange(zoomed);
                      runQuery(zoomed);
                    }}
                  />
                </Suspense>
              </Spin>
            )}
          </Card>
        )}

        {/* Search error (non-NotInstalled) */}
        {search.error && !isResourceNotAvailable(search.error) && (
          <Result
            status="warning"
            title={intl.formatMessage({ id: 'pages.logging.error.title' })}
            subTitle={String(
              // Three error shapes can reach here: SSE rejected payload
              // ({code, message, status}), umi REST error wrapping a
              // JSON body ({response:{data:{message}}}), and a plain
              // Error. Prefer the most specific available.
              (search.error as { message?: string }).message ??
                (search.error as {
                  response?: { data?: { message?: string } };
                })?.response?.data?.message ??
                'unknown error',
            )}
          />
        )}

        {/* Truncation banner — only after a complete run lands a
            summary. While streaming we don't know yet whether we'll
            hit the cap, so the banner stays hidden. */}
        {search.summary?.truncated && (
          <Alert
            type="info"
            showIcon
            message={intl.formatMessage(
              { id: 'pages.logging.truncated' },
              { n: lines.length },
            )}
          />
        )}

        {/* Partial-result banner — fires when the worker reported
            the upstream connection died mid-stream. Shows alongside
            the rows that DID arrive so the investigator knows the
            view isn't complete. */}
        {search.summary?.endErr && (
          <Alert
            type="warning"
            showIcon
            message={intl.formatMessage(
              { id: 'pages.logging.partialResult' },
              { n: lines.length, err: search.summary.endErr },
            )}
          />
        )}
      </Space>
      )}

      {/* Results list — owns the only scroll context on the page. Card
          flexes to fill remaining viewport; Virtuoso virtualises the
          rows so 10k results render with bounded DOM and constant
          scroll cost. Spin is rendered as an absolute-positioned
          overlay (instead of Spin-wrapping the children) because
          Spin's `ant-spin-nested-loading` wrapper doesn't propagate
          flex height down to Virtuoso, breaking its height: 100%
          measurement. */}
      {submitted && (
        <Card
          size="small"
          title={
            <Space>
              <Typography.Text strong>
                {intl.formatMessage({ id: 'pages.logging.results.title' })}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {/* Same caption shape during streaming and after
                    completion — only the verb differs ("loaded"
                    while in flight, just "N rows" after done).
                    The elapsed-time tail stays so a quick query
                    still shows its duration after it finishes. */}
                {intl.formatMessage(
                  {
                    id: search.loading
                      ? 'pages.logging.results.streaming'
                      : 'pages.logging.results.count',
                  },
                  {
                    n: lines.length,
                    sec: ((search.elapsedMs || 0) / 1000).toFixed(1),
                  },
                )}
              </Typography.Text>
              {search.loading && <Spin size="small" />}
            </Space>
          }
          extra={
            <Space size={4}>
              <Dropdown
                disabled={!lines.length}
                menu={{
                  items: [
                    {
                      key: 'txt',
                      label: intl.formatMessage({
                        id: 'pages.logging.export.txt',
                      }),
                      onClick: () => onExport('txt'),
                    },
                    {
                      key: 'ndjson',
                      label: intl.formatMessage({
                        id: 'pages.logging.export.ndjson',
                      }),
                      onClick: () => onExport('ndjson'),
                    },
                  ],
                }}
              >
                <Button
                  size="small"
                  type="text"
                  icon={<DownloadOutlined />}
                  disabled={!lines.length}
                >
                  {intl.formatMessage({ id: 'pages.logging.export' })}
                </Button>
              </Dropdown>
              <Tooltip
                title={intl.formatMessage({
                  id: fullscreen
                    ? 'pages.logging.fullscreen.exit'
                    : 'pages.logging.fullscreen.enter',
                })}
              >
                <Button
                  size="small"
                  type="text"
                  icon={
                    fullscreen ? (
                      <FullscreenExitOutlined />
                    ) : (
                      <FullscreenOutlined />
                    )
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
          {lines.length === 0 && !search.loading ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              style={{ padding: 32 }}
              description={intl.formatMessage({
                id: 'pages.logging.results.empty',
              })}
            />
          ) : (
            <Virtuoso
              style={{ flex: 1, minHeight: 0 }}
              data={lines}
              // Virtuoso anchors at index 0 by default. We prepend
              // newest lines (in both live tail and search modes),
              // so the user always sees the most recent record at
              // the top without any scroll math.
              itemContent={(_index, ln) => (
                <LogRow
                  line={ln}
                  highlightTerms={highlightTerms}
                  onFilterPod={(ns, pod) => {
                    // "筛选此 Pod" — set the picker to the clicked
                    // pod and re-run the search so the user can
                    // drill into a single workload from a noisy
                    // multi-pod result.
                    onPickerChange(ns, pod, '');
                  }}
                />
              )}
            />
          )}
        </Card>
      )}
    </div>
  );
};

// LogRow renders one log line as a wrapped pre block with the
// hostname/namespace/pod chips prefixed for context. Clicking the
// row expands it to show:
//   - JSON-pretty version of message when message is valid JSON
//   - key/value table of structured fields (line.fields, sourced
//     from Vector / containerd attributes)
//
// React.memo — CRITICAL for streaming search performance. setLines
// fires ~20×/sec while a query is in flight; without memo, virtuoso's
// itemContent re-creates LogRow JSX on every render, and React walks
// the antd Tag / Typography subtree for every visible row even though
// the row's data didn't change. With memo + the append-only lines[]
// pattern (prev.slice() copies REFERENCES, so lines[i] === oldLines[i]
// for unchanged indices), React skips the reconcile for non-tail rows.
// Trims ~6 % CPU on a 10k-row stream.
//
// `highlightTerms` is captured into a stable ref via the parent's
// useMemo (keyed by submitted query) — same reference for every row
// of a single result set, so memo equality stays cheap.
const LogRow = React.memo(function LogRow({
  line,
  highlightTerms,
  onFilterPod,
}: {
  line: LogLine;
  highlightTerms: string[];
  // Triggered from the per-row Dropdown menu — pin the picker to
  // this pod so subsequent searches scope to it. Receives ns + pod
  // from the line so the row stays stateless.
  onFilterPod?: (namespace: string, pod: string) => void;
}) {
  const intl = useIntl();
  const t = new Date(line.time);
  const ts = Number.isNaN(t.getTime())
    ? line.time
    : t.toLocaleString();
  // stream=stderr is informational only — Python logging, Go log,
  // nginx access logs and plenty of others write everything to
  // stderr regardless of severity. We surface it as a neutral chip
  // so the operator can SEE which stream a line came from, but we
  // don't paint it red.
  const isStderr = line.stream === 'stderr';
  // Actual error highlight comes from the application's own level
  // field if one exists. Vector preserves structured attributes
  // verbatim under line.fields; common keys are `level` (logrus,
  // zap, zerolog, slog, structlog), `severity` (Google Cloud
  // Logging, K8s API audit), and `lvl` (older zap). Lowercase for
  // case-insensitive matching. Empty → no highlight.
  const levelRaw =
    line.fields?.level ?? line.fields?.severity ?? line.fields?.lvl ?? '';
  const level = levelRaw.toLowerCase();
  const isError =
    level === 'error' ||
    level === 'err' ||
    level === 'fatal' ||
    level === 'crit' ||
    level === 'critical' ||
    level === 'panic';
  const isWarn = level === 'warn' || level === 'warning';
  const [expanded, setExpanded] = React.useState(false);
  // Detect & pretty-print JSON message. Only attempt parse when the
  // user expands — keeps streaming append cheap (most lines never
  // get expanded). Cached via useMemo so repeated re-renders while
  // expanded don't re-parse.
  const pretty = React.useMemo<string | null>(() => {
    if (!expanded) return null;
    const m = (line.message ?? '').trim();
    if (!m.startsWith('{') && !m.startsWith('[')) return null;
    try {
      return JSON.stringify(JSON.parse(m), null, 2);
    } catch {
      return null;
    }
  }, [expanded, line.message]);
  // Stable sorted entries of structured fields. Sorted so the table
  // doesn't reshuffle if Vector reorders attributes between records.
  const fieldEntries = React.useMemo(() => {
    const f = line.fields ?? {};
    return Object.entries(f).sort((a, b) => a[0].localeCompare(b[0]));
  }, [line.fields]);
  return (
    <div
      style={{
        padding: '6px 12px',
        borderBottom: '1px solid var(--ant-color-split)',
        // Left border / tint reflects log SEVERITY (level field),
        // not stream. Errors get red, warnings get amber, every-
        // thing else stays neutral.
        borderLeft: isError
          ? '3px solid var(--ant-color-error)'
          : isWarn
            ? '3px solid var(--ant-color-warning)'
            : '3px solid transparent',
        background: isError
          ? 'color-mix(in srgb, var(--ant-color-error) 6%, transparent)'
          : isWarn
            ? 'color-mix(in srgb, var(--ant-color-warning) 5%, transparent)'
            : undefined,
        fontFamily:
          'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
        fontSize: 12,
        lineHeight: 1.5,
        wordBreak: 'break-all',
        whiteSpace: 'pre-wrap',
        cursor: 'pointer',
      }}
      onClick={(e) => {
        // Don't toggle if the user is selecting text (drag-select).
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;
        // Don't toggle on clicks inside antd Tags (they may have
        // their own jump menu in a later iteration).
        const tag = (e.target as HTMLElement | null)?.closest?.(
          '.ant-tag',
        );
        if (tag) return;
        setExpanded((v) => !v);
      }}
    >
      <Space size={6} wrap style={{ marginRight: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {ts}
        </Typography.Text>
        {line.namespace && (
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
            {line.namespace}
          </Tag>
        )}
        {line.pod && (
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: 'filter',
                  disabled: !onFilterPod,
                  label: intl.formatMessage({
                    id: 'pages.logging.row.filterByPod',
                  }),
                  onClick: () =>
                    onFilterPod?.(line.namespace ?? '', line.pod ?? ''),
                },
                {
                  key: 'copy',
                  label: intl.formatMessage({
                    id: 'pages.logging.row.copyPodName',
                  }),
                  onClick: () => {
                    if (line.pod) {
                      navigator.clipboard?.writeText(line.pod).catch(() => {
                        // Clipboard may be unavailable in non-https
                        // dev mode — fall back to selection so the
                        // user can manually copy.
                      });
                    }
                  },
                },
              ],
            }}
          >
            <Tag style={{ marginInlineEnd: 0, cursor: 'pointer' }}>
              {line.pod}
            </Tag>
          </Dropdown>
        )}
        {line.container && (
          <Tag color="default" style={{ marginInlineEnd: 0 }}>
            {line.container}
          </Tag>
        )}
        {isStderr && (
          <Tag color="default" style={{ marginInlineEnd: 0 }}>
            stderr
          </Tag>
        )}
        {levelRaw && (
          <Tag
            color={
              isError ? 'red' : isWarn ? 'orange' : 'default'
            }
            style={{ marginInlineEnd: 0 }}
          >
            {levelRaw}
          </Tag>
        )}
      </Space>
      <HighlightedMessage
        text={line.message ?? ''}
        terms={highlightTerms}
      />
      {expanded && (pretty || fieldEntries.length > 0) && (
        <div
          style={{
            marginTop: 8,
            padding: 8,
            background: 'var(--ant-color-fill-quaternary)',
            borderRadius: 4,
          }}
          onClick={(e) => {
            // Click inside the expanded panel shouldn't collapse —
            // user is probably trying to select / copy a field.
            e.stopPropagation();
          }}
        >
          {pretty && (
            <pre
              style={{
                margin: 0,
                marginBottom: fieldEntries.length > 0 ? 8 : 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {pretty}
            </pre>
          )}
          {fieldEntries.length > 0 && (
            <table style={{ width: '100%', fontSize: 11 }}>
              <tbody>
                {fieldEntries.map(([k, v]) => (
                  <tr
                    key={k}
                    style={{
                      borderTop: '1px solid var(--ant-color-split)',
                    }}
                  >
                    <td
                      style={{
                        padding: '2px 8px',
                        verticalAlign: 'top',
                        color: 'var(--ant-color-text-secondary)',
                        width: 220,
                        wordBreak: 'break-all',
                      }}
                    >
                      {k}
                    </td>
                    <td
                      style={{
                        padding: '2px 8px',
                        verticalAlign: 'top',
                        wordBreak: 'break-all',
                      }}
                    >
                      {v}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
});

// HighlightedMessage wraps occurrences of `terms` in <mark> so the
// matched portions stand out. Case-insensitive. Empty terms list →
// plain text (no DOM overhead for queries that have no text search).
//
// Single regex with all alternatives + the global+case-insensitive
// flags is one pass over the string. Iteration with exec lets us
// build only the spans we need rather than allocating a `split` array.
const HighlightedMessage: React.FC<{ text: string; terms: string[] }> =
  React.memo(({ text, terms }) => {
    if (terms.length === 0 || !text) return <span>{text}</span>;
    // Build alternation pattern. Order terms by length desc so a
    // longer phrase wins over a substring of itself if both apply.
    const sorted = [...terms].sort((a, b) => b.length - a.length);
    const pattern = sorted.map(escapeRegex).join('|');
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'gi');
    } catch {
      // Malformed pattern (extreme edge case after escaping shouldn't
      // happen, belt-and-braces) — fall back to plain text.
      return <span>{text}</span>;
    }
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > lastIndex) {
        parts.push(text.slice(lastIndex, m.index));
      }
      parts.push(
        <mark
          key={`${m.index}-${m[0]}`}
          style={{
            backgroundColor: 'color-mix(in srgb, var(--ant-color-warning) 35%, transparent)',
            color: 'inherit',
            padding: 0,
            borderRadius: 2,
          }}
        >
          {m[0]}
        </mark>,
      );
      lastIndex = m.index + m[0].length;
      // Defend against zero-length matches infinite-looping.
      if (m[0].length === 0) re.lastIndex++;
    }
    if (lastIndex < text.length) parts.push(text.slice(lastIndex));
    return <span>{parts}</span>;
  });

export default LoggingPage;
