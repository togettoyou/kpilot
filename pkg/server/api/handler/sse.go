// Package handler — Server-Sent Events helper for long-running query
// endpoints.
//
// Most managed HTTPS ingresses close connections that haven't sent any
// bytes for ~60–300 s. A synchronous `c.JSON(...)` at the end of a
// slow logs/search query that takes 4+ minutes ends up RST'd by the
// ingress before the handler ever gets to write a byte — the user
// sees `http=000` with no error body to translate.
//
// SSE side-steps this: we flush the response headers immediately,
// stream `progress` keep-alive events every 25 s, and emit a single
// terminal `result` (success) or `error` event when the underlying
// query returns. The browser opens the endpoint with EventSource and
// listens for those three event names.
//
// Wire format is plain text/event-stream so a curl request still
// reads cleanly:
//
//   event: progress
//   data: {"elapsedMs":25000}
//
//   event: result
//   data: { … the original logSearchResponse JSON … }
package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"

	serverdiag "github.com/togettoyou/kpilot/pkg/server/diag"

	kplog "github.com/togettoyou/kpilot/pkg/log"
)

var sseLog = kplog.L("handler")

// sseKeepaliveInterval is how often we emit a `progress` event while
// the underlying query is still in flight. 25 s sits comfortably under
// every common HTTPS proxy default (nginx 60 s with proxy_read_timeout
// overridden, AWS ALB 60 s by default, GCP HTTPS LB 30 s, most managed
// ingress controllers 60–300 s). Smaller values waste bytes; larger
// values risk picking up new proxy configs that we don't control.
const sseKeepaliveInterval = 25 * time.Second

// sseWriteTimeout caps how long a single SSE write can block. This
// is the safety valve against the "browser EventSource.close() but
// keep TCP keep-alive open" failure mode: client stops reading,
// kernel send buffer fills, Write blocks forever waiting for buffer
// to drain. Without this deadline, streamVMLogs's onLine wedges
// indefinitely, the gateway's per-worker recv loop backs up on the
// chunks channel, and EVERY other request to that worker hangs.
//
// 5 s is generous for any healthy write (typical SSE event = ~150
// bytes, completes in microseconds) but short enough that a stuck
// client surfaces fast. After a write-deadline timeout, Fprintf
// returns an error → sse.send returns error → onLine returns error
// → streamVMLogs exits → defer stream.Close → yamux FIN to worker
// → worker's next upstream write fails → upstream HTTP request
// ctx is cancelled → cascading cleanup.
const sseWriteTimeout = 5 * time.Second

// sseStream wraps a gin response writer with the bits SSE needs:
// flush after every event, and a mutex so the keep-alive goroutine
// doesn't race with the final result emit. NOT exported — only the
// helpers in this file should construct one.
type sseStream struct {
	c       *gin.Context
	flusher http.Flusher
	mu      sync.Mutex
	started time.Time
	closed  atomic.Bool // diag.SSEClients decrement guard — idempotent Close
}

// startSSE writes the SSE response headers and flushes them, so the
// browser sees the connection as "live" before the first event. Returns
// nil + writes 500 if the underlying ResponseWriter doesn't support
// http.Flusher (shouldn't happen with stock net/http, but we degrade
// loud rather than silently buffering).
func startSSE(c *gin.Context) *sseStream {
	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		apiErrInternal(c, fmt.Errorf("ResponseWriter does not support Flusher"))
		return nil
	}
	// Increment BEFORE writing the response headers — paired with the
	// matching decrement in s.Close(). Callers MUST defer s.Close().
	serverdiag.SSEClients.Add(1)
	h := c.Writer.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	// nginx-family proxies (nginx-ingress, openresty, …) buffer
	// text/event-stream responses by default unless told otherwise;
	// this header is the documented opt-out. Harmless on other proxies
	// that don't know about it.
	h.Set("X-Accel-Buffering", "no")
	c.Writer.WriteHeader(http.StatusOK)
	flusher.Flush()
	return &sseStream{c: c, flusher: flusher, started: time.Now()}
}

// send emits one event with the given name and a JSON-encoded payload.
// Holds the mu so it can be called from both the main handler and the
// keep-alive goroutine without interleaving partial frames. Returns the
// underlying write error so callers can short-circuit if the client
// disconnected (broken-pipe). payload may be nil — emits `data: null`.
func (s *sseStream) send(event string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal sse payload: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Per-write deadline so a stuck client (closed EventSource but
	// kept TCP keep-alive open, so kernel send buffer never drains)
	// can't wedge us indefinitely. ResponseController is Go 1.20+;
	// SetWriteDeadline returns ErrNotSupported on writers without
	// an underlying net.Conn (mocks, etc.) — we ignore that and
	// proceed without the safety net. The deadline is cleared
	// after the write so future writes (or transitions to a
	// non-streamed response) aren't accidentally constrained.
	rc := http.NewResponseController(s.c.Writer)
	_ = rc.SetWriteDeadline(time.Now().Add(sseWriteTimeout))
	defer func() { _ = rc.SetWriteDeadline(time.Time{}) }()
	if _, err := fmt.Fprintf(s.c.Writer, "event: %s\ndata: %s\n\n", event, body); err != nil {
		return err
	}
	s.flusher.Flush()
	return nil
}

// startKeepalive spawns a goroutine that emits a `progress` event every
// sseKeepaliveInterval until stopCh closes (or the client disconnects).
// Payload is `{"elapsedMs": <ms since startSSE>}` so the frontend can
// show "querying… 25 s" feedback. Returns a stop function the caller
// must defer — closes stopCh and waits for the goroutine to drain.
func (s *sseStream) startKeepalive() (stop func()) {
	stopCh := make(chan struct{})
	doneCh := make(chan struct{})
	go func() {
		defer close(doneCh)
		t := time.NewTicker(sseKeepaliveInterval)
		defer t.Stop()
		for {
			select {
			case <-stopCh:
				return
			case <-s.c.Request.Context().Done():
				return
			case <-t.C:
				if err := s.send("progress", map[string]any{
					"elapsedMs": time.Since(s.started).Milliseconds(),
				}); err != nil {
					// Client gone — main handler will notice on its own
					// next write too. Just exit the keep-alive loop.
					return
				}
			}
		}
	}()
	return func() {
		close(stopCh)
		<-doneCh
	}
}

// Close drops the connection's contribution to diag.SSEClients.
// Idempotent: safe to call from multiple defer chains. Callers MUST
// `defer s.Close()` right after startSSE, otherwise the gauge leaks
// upward on every handler return.
func (s *sseStream) Close() {
	if s.closed.CompareAndSwap(false, true) {
		serverdiag.SSEClients.Add(-1)
	}
}

// sseError emits a terminal `error` event with the shape the frontend
// expects: { code, message, status }. Code matches the regular REST
// error code table (errors.{CODE}); status is the HTTP status that
// the equivalent non-SSE handler would have returned, so the frontend
// can still differentiate "404 RESOURCE_NOT_AVAILABLE" from "500
// INTERNAL_ERROR" without parsing the body twice.
func (s *sseStream) sendError(code, message string, httpStatus int) {
	_ = s.send("error", map[string]any{
		"code":    code,
		"message": message,
		"status":  httpStatus,
	})
}

// sseInternalError logs the underlying err and emits an INTERNAL_ERROR
// SSE event. Mirrors apiErrInternal in the REST path — operator sees the
// real error in server logs, the client sees the generic code.
func (s *sseStream) sendInternalError(err error) {
	// Mirror apiErrInternal's log line so existing log greps still work.
	sseLog.Warnf("internal error: %v", err)
	s.sendError(CodeInternalError, "", http.StatusInternalServerError)
}
