// Package gateway — v2 send paths (P-Transport-v2).
//
// Each Send* method opens a fresh yamux stream on the worker's
// session, writes the typed *Start frame, writes any raw body
// bytes, half-closes, reads the typed response frame, optionally
// reads response body bytes. Stream close handles cancellation.
//
// Replaces v1's pending response map + prioritySender + chunked
// framing — yamux handles flow control + per-RPC isolation
// natively (see docs/transport-v2.md).
package gateway

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/google/uuid"

	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	transportv2 "github.com/togettoyou/kpilot/pkg/transport/yamux"
)

// resourceUseGzip — JSON / unstructured / Table API responses
// compress 5-8× on cross-WAN links; default to gzip on for
// Resource RPCs.
const resourceUseGzip = true

// httpRequestUseGzip — Grafana / VM / VL responses are JSON or
// text and compress well too. Inference SSE chunks are tiny
// per-line and gzip per-line Flush amortises poorly; the SSE
// path leaves gzip off via SendHTTPRequestStream's hardcoded
// false.
const httpRequestUseGzip = true

// watchCtx spawns a goroutine that FINs the underlying yamux
// stream when ctx fires. Returns a release func the caller
// defers — when the real work is done, releasing unblocks the
// watcher so it exits without touching the stream. Necessary
// because yamux's Read / Write only react to wall-clock
// deadlines (via SetDeadline), not Go context cancellation;
// without the watcher, a caller that cancels the parent ctx
// waits until any explicit deadline fires (or forever if none
// was set).
//
// Uses st.Raw().Close (FIN) instead of st.Close() because the
// latter flushes the gzip writer — which races with whatever
// gzip.Writer.Write the main goroutine might be running
// concurrently (race detector flagged this on every cancel
// during a body write). The caller's own `defer st.Close()`
// handles the gzip flush in the normal exit path after the
// main flow has stopped writing.
func watchCtx(ctx context.Context, st *transportv2.Stream) func() {
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = st.Raw().Close()
		case <-done:
		}
	}()
	return func() { close(done) }
}

// SendResourceRequest opens a STREAM_RESOURCE_REQUEST yamux
// stream, ships the request + optional body, then reads back
// the response + optional response body.
func (g *GatewayServer) SendResourceRequest(ctx context.Context, clusterID string, req *ResourceRequest) (*ResourceResponse, error) {
	w, ok := g.GetWorker(clusterID)
	if !ok {
		return nil, fmt.Errorf("cluster %s not connected", clusterID)
	}
	st, err := w.Session.Open(ctx, pbv2.StreamKind_STREAM_RESOURCE_REQUEST, uuid.NewString(), resourceUseGzip)
	if err != nil {
		return nil, fmt.Errorf("open resource stream: %w", err)
	}
	defer st.Close()
	applyCtxDeadline(ctx, st)
	defer watchCtx(ctx, st)()

	if err := st.WriteMsg(&pbv2.ResourceRequest{
		Action:        req.Action,
		Group:         req.Group,
		Version:       req.Version,
		Kind:          req.Kind,
		Namespace:     req.Namespace,
		Name:          req.Name,
		Limit:         req.Limit,
		ContinueToken: req.ContinueToken,
		LabelSelector: req.LabelSelector,
		BodySize:      int64(len(req.Body)),
	}); err != nil {
		return nil, fmt.Errorf("write resource req: %w", err)
	}
	if len(req.Body) > 0 {
		if _, err := st.Writer().Write(req.Body); err != nil {
			return nil, fmt.Errorf("write resource body: %w", err)
		}
		// Flush — gzip writer buffers up to ~32 KiB internally; without
		// this the body bytes sit in the buffer while the worker's
		// io.ReadFull blocks forever (deadlock).
		if err := st.Flush(); err != nil {
			return nil, fmt.Errorf("flush resource body: %w", err)
		}
	}
	// NO CloseWrite. Worker reads exactly BodySize bytes (knows
	// request body is done), then spawns a cancel-watcher to react
	// to consumer cancel via watchCtx's eventual st.Close. A
	// CloseWrite here would FIN immediately, the watcher would
	// fire instantly, and the K8s op would be cancelled before it
	// even started. See docs/transport-v2.md §16.

	var startResp pbv2.ResourceResponse
	if err := st.ReadMsg(&startResp); err != nil {
		return nil, g.mapStreamErr(clusterID, err, "read resource resp")
	}
	resp := &ResourceResponse{
		Success: startResp.GetSuccess(),
		Error:   startResp.GetError(),
	}
	if size := startResp.GetBodySize(); size > 0 {
		body := make([]byte, size)
		if _, err := io.ReadFull(st.Reader(), body); err != nil {
			return nil, fmt.Errorf("read resource body: %w", err)
		}
		resp.Data = body
	}
	return resp, nil
}

// SendHTTPRequest opens a STREAM_HTTP_REQUEST yamux stream
// (stream_response = false → worker buffers the upstream
// response before replying). Used by Grafana / VM / VL /
// non-streaming inference / etc.
func (g *GatewayServer) SendHTTPRequest(ctx context.Context, clusterID string, req *HTTPRequest) (*HTTPResponse, error) {
	w, ok := g.GetWorker(clusterID)
	if !ok {
		return nil, fmt.Errorf("cluster %s not connected", clusterID)
	}
	st, err := w.Session.Open(ctx, pbv2.StreamKind_STREAM_HTTP_REQUEST, uuid.NewString(), httpRequestUseGzip)
	if err != nil {
		return nil, fmt.Errorf("open http stream: %w", err)
	}
	defer st.Close()
	applyCtxDeadline(ctx, st)
	defer watchCtx(ctx, st)()

	if err := st.WriteMsg(&pbv2.HTTPRequestStart{
		Method:         req.Method,
		Url:            req.URL,
		Headers:        req.Headers,
		BodySize:       int64(len(req.Body)),
		StreamResponse: false,
	}); err != nil {
		return nil, fmt.Errorf("write http req: %w", err)
	}
	if len(req.Body) > 0 {
		if _, err := st.Writer().Write(req.Body); err != nil {
			return nil, fmt.Errorf("write http body: %w", err)
		}
		if err := st.Flush(); err != nil {
			return nil, fmt.Errorf("flush http body: %w", err)
		}
	}
	// NO CloseWrite (see SendResourceRequest for the rationale).
	// Worker reads BodySize bytes then spawns a cancel-watcher.

	var startResp pbv2.HTTPResponseStart
	if err := st.ReadMsg(&startResp); err != nil {
		return nil, g.mapStreamErr(clusterID, err, "read http resp")
	}
	resp := &HTTPResponse{
		Status:  startResp.GetStatus(),
		Headers: startResp.GetHeaders(),
		Error:   startResp.GetError(),
	}
	if size := startResp.GetBodySize(); size > 0 {
		body := make([]byte, size)
		if _, err := io.ReadFull(st.Reader(), body); err != nil {
			return nil, fmt.Errorf("read http body: %w", err)
		}
		resp.Body = body
	}
	return resp, nil
}

// applyCtxDeadline propagates a context deadline (if any) down
// to the underlying yamux stream so blocked Read / Write inside
// st.WriteMsg / st.ReadMsg return when the caller's deadline
// fires. yamux.Stream implements net.Conn so this is just
// SetDeadline.
func applyCtxDeadline(ctx context.Context, st *transportv2.Stream) {
	dl, ok := ctx.Deadline()
	if !ok {
		return
	}
	_ = st.Raw().SetDeadline(dl)
}

// mapStreamErr converts low-level transport errors to nicer
// caller messages. Two failure modes to distinguish:
//
//   - The yamux SESSION died (worker disconnected, keepalive
//     timeout, network drop). All in-flight stream Reads return
//     io.EOF as the session is torn down. The right message is
//     "worker disconnected" — telling the operator to check the
//     worker pod, not the handler.
//   - The STREAM ended early while the session is still alive.
//     Almost always a worker-side handler panic / early return.
//
// Checking g.GetWorker at error time is a reliable signal: if
// the worker is no longer in the registry, unregister already
// fired and the session is dead. Tiny race window (worker drops
// → unregister hasn't run yet) but the resulting "handler panic"
// message is roughly accurate for that millisecond gap.
func (g *GatewayServer) mapStreamErr(clusterID string, err error, what string) error {
	if err == nil {
		return nil
	}
	if _, connected := g.GetWorker(clusterID); !connected {
		return fmt.Errorf("%s: worker disconnected", what)
	}
	if errors.Is(err, io.EOF) {
		return fmt.Errorf("%s: worker closed stream early (likely handler panic)", what)
	}
	return fmt.Errorf("%s: %w", what, err)
}
