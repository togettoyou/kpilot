// logs.ts — services for the cluster Logging page. Two endpoints
// (search + histogram) share the same query / from / to / limit
// parameters so the page can fire them in parallel.
//
// Both endpoints respond with Server-Sent Events (text/event-stream),
// NOT JSON. The shape of the terminal `result` event matches what the
// REST handlers used to return; the SSE wrapper makes the call appear
// promise-shaped so existing call sites barely change. See
// pkg/server/api/handler/sse.go on the backend for the wire format
// and motivation (managed HTTPS ingresses idle-timeout the connection
// when no bytes flow for ~60–300 s, which used to trip on slow
// cross-WAN log queries — periodic `progress` keep-alives prevent it).

export interface LogLine {
  time: string;
  message: string;
  stream?: string;
  namespace?: string;
  pod?: string;
  container?: string;
  node?: string;
  fields?: Record<string, string>;
}

// LogsMeta — payload of the first SSE event on a streaming search.
// Tells the UI what query / range / limit the server resolved to,
// so the caption can render before the first line lands.
export interface LogsMeta {
  query: string;
  from: string;
  to: string;
  generatedAt: string;
  limit: number;
}

// LogsResult — payload of the terminal SSE event on a streaming
// search. By the time it fires the frontend already received `total`
// `line` events (or fewer if truncated/endErr fired early).
export interface LogsResult {
  total: number;
  truncated: boolean;
  elapsedMs: number;
  // Non-empty when the worker reported the upstream connection
  // failed partway through (truncated VL response). The UI shows
  // a "results may be incomplete" banner alongside the rows that
  // DID arrive.
  endErr?: string;
}

export interface LogsHistogramPoint {
  ts: number;
  count: number;
}

export interface LogsHistogramResponse {
  query: string;
  from: string;
  to: string;
  generatedAt: string;
  stepSeconds: number;
  points: LogsHistogramPoint[];
  total: number;
}

export interface LogQueryParams {
  query: string;
  from: string; // RFC3339
  to: string;   // RFC3339
  limit?: number;
}

// SseError mirrors the JSON payload of the server's terminal `error`
// event. Code matches the existing errors.{CODE} translation table,
// so the requestErrorConfig handler shape still applies — pages call
// `formatMessage({ id: 'errors.' + err.code })` to render it.
export interface SseError {
  code: string;
  message?: string;
  status: number;
}

export interface SseQueryOptions {
  /** Called when a `progress` heartbeat arrives. elapsedMs is server-side. */
  onProgress?: (elapsedMs: number) => void;
  /** Abort signal — closing the EventSource on cancel stops the server-side
   *  context too via gRPC stream context propagation. */
  signal?: AbortSignal;
}

// runSseQuery opens an EventSource against `url` and resolves with the
// first `result` event's payload, rejects with `error` event payload or
// a connection-level failure. Generic over T because both search and
// histogram share the wire format but differ in result shape.
function runSseQuery<T>(url: string, opts?: SseQueryOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const es = new EventSource(url, { withCredentials: true });
    let settled = false;

    const cleanup = () => {
      settled = true;
      es.close();
      if (opts?.signal) {
        opts.signal.removeEventListener('abort', onAbort);
      }
    };

    const onAbort = () => {
      if (settled) return;
      cleanup();
      // AbortError-like — frontends typically swallow this rather than
      // showing a toast.
      reject(new DOMException('aborted', 'AbortError'));
    };
    if (opts?.signal) {
      if (opts.signal.aborted) {
        es.close();
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      opts.signal.addEventListener('abort', onAbort);
    }

    es.addEventListener('progress', (e: MessageEvent) => {
      if (!opts?.onProgress) return;
      try {
        const data = JSON.parse(e.data);
        opts.onProgress(typeof data.elapsedMs === 'number' ? data.elapsedMs : 0);
      } catch {
        /* malformed progress payload — non-fatal */
      }
    });

    es.addEventListener('result', (e: MessageEvent) => {
      if (settled) return;
      cleanup();
      try {
        resolve(JSON.parse(e.data) as T);
      } catch (err) {
        reject(err);
      }
    });

    // The standard `error` event fires for BOTH (a) the server-emitted
    // terminal `event: error\ndata: …` AND (b) connection-level
    // failures (network, TLS, ingress RST). Distinguish by presence of
    // `.data`: case (a) carries the SseError JSON; (b) carries nothing.
    es.addEventListener('error', (e: MessageEvent) => {
      if (settled) return;
      if (e?.data) {
        cleanup();
        let err: SseError;
        try {
          err = JSON.parse(e.data) as SseError;
        } catch {
          err = { code: 'INTERNAL_ERROR', status: 500 };
        }
        reject(err);
        return;
      }
      // Connection-level — close aggressively to disable EventSource's
      // built-in retry loop (we don't want a long query auto-replayed
      // on every transient disconnect).
      cleanup();
      reject({ code: 'CONNECTION_LOST', status: 0 } as SseError);
    });
  });
}

// buildQueryString assembles a `?k=v&…` suffix from a params record.
// Skips undefined values so callers can spread optional fields without
// littering the URL with `&limit=undefined`.
function buildQueryString(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// streamLogsSearch is the streaming-variant of the old `searchLogs`.
// The server emits one SSE `line` event per matching log record live
// as the worker tunnel delivers chunks from VictoriaLogs, plus a
// `meta` event up front and a `result` summary at the end.
//
// onLine receives lines in BATCHES (not one-by-one) so the UI can
// append to virtuoso at a sustainable cadence — for high-volume
// queries firing setState per line trashes React reconciliation +
// the virtuoso list rebuild. Batching window is 50 ms or 100 lines,
// whichever fires first; flush also happens on `result` so the
// final tail isn't dropped.
//
// Promise resolves on `result`, rejects on `error` or
// connection-level failure. AbortSignal closes the EventSource,
// which propagates server-side via the request context (and
// eventually winds down the worker upstream connection on its
// 5 min vmlogsTimeout — see P16-D for proper cancel-frame).
export interface LogsStreamHandler {
  onMeta?: (meta: LogsMeta) => void;
  onLine: (lines: LogLine[]) => void;
  onProgress?: (elapsedMs: number) => void;
}

export function streamLogsSearch(
  clusterId: string,
  p: LogQueryParams,
  handler: LogsStreamHandler,
  opts?: { signal?: AbortSignal },
): Promise<LogsResult> {
  const qs = buildQueryString({
    query: p.query,
    from: p.from,
    to: p.to,
    limit: p.limit,
  });
  const url = `/api/v1/clusters/${clusterId}/logs/search${qs}`;

  return new Promise<LogsResult>((resolve, reject) => {
    const es = new EventSource(url, { withCredentials: true });
    let settled = false;

    // Batching state for onLine.
    const batchMs = 50;
    const batchMax = 100;
    let pending: LogLine[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (pending.length === 0) return;
      const out = pending;
      pending = [];
      try {
        handler.onLine(out);
      } catch (err) {
        // Don't let a bad handler tear down the stream — log + carry on.
        // eslint-disable-next-line no-console
        console.error('[logs-stream] onLine handler threw', err);
      }
    };
    const scheduleFlush = () => {
      if (flushTimer !== null) return;
      flushTimer = setTimeout(flush, batchMs);
    };

    const cleanup = () => {
      settled = true;
      flush();
      es.close();
      if (opts?.signal) {
        opts.signal.removeEventListener('abort', onAbort);
      }
    };

    const onAbort = () => {
      if (settled) return;
      cleanup();
      reject(new DOMException('aborted', 'AbortError'));
    };
    if (opts?.signal) {
      if (opts.signal.aborted) {
        es.close();
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      opts.signal.addEventListener('abort', onAbort);
    }

    es.addEventListener('meta', (e: MessageEvent) => {
      if (!handler.onMeta) return;
      try {
        handler.onMeta(JSON.parse(e.data) as LogsMeta);
      } catch {
        /* malformed meta — non-fatal */
      }
    });

    es.addEventListener('progress', (e: MessageEvent) => {
      if (!handler.onProgress) return;
      try {
        const data = JSON.parse(e.data);
        handler.onProgress(
          typeof data.elapsedMs === 'number' ? data.elapsedMs : 0,
        );
      } catch {
        /* malformed progress — non-fatal */
      }
    });

    es.addEventListener('line', (e: MessageEvent) => {
      if (settled) return;
      try {
        const ln = JSON.parse(e.data) as LogLine;
        pending.push(ln);
        if (pending.length >= batchMax) {
          flush();
        } else {
          scheduleFlush();
        }
      } catch {
        /* malformed line — skip silently */
      }
    });

    es.addEventListener('result', (e: MessageEvent) => {
      if (settled) return;
      cleanup();
      try {
        resolve(JSON.parse(e.data) as LogsResult);
      } catch (err) {
        reject(err);
      }
    });

    // Standard `error` event covers BOTH server-emitted terminal
    // errors AND connection-level failures. Same distinction as
    // runSseQuery: presence of `.data` ⇒ (a), absence ⇒ (b).
    es.addEventListener('error', (e: MessageEvent) => {
      if (settled) return;
      if (e?.data) {
        cleanup();
        let err: SseError;
        try {
          err = JSON.parse(e.data) as SseError;
        } catch {
          err = { code: 'INTERNAL_ERROR', status: 500 };
        }
        reject(err);
        return;
      }
      cleanup();
      reject({ code: 'CONNECTION_LOST', status: 0 } as SseError);
    });
  });
}

export function logsHistogram(
  clusterId: string,
  p: LogQueryParams,
  opts?: SseQueryOptions,
): Promise<LogsHistogramResponse> {
  const qs = buildQueryString({ query: p.query, from: p.from, to: p.to });
  return runSseQuery<LogsHistogramResponse>(
    `/api/v1/clusters/${clusterId}/logs/histogram${qs}`,
    opts,
  );
}
