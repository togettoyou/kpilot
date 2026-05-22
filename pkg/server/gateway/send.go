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

// resourceTimeoutGzip — JSON / unstructured / Table API responses
// compress 5-8× on cross-WAN links; default to gzip on for
// Resource RPCs.
const resourceUseGzip = true

// httpRequestUseGzip — Grafana / VM / VL responses are JSON or
// text and compress well too. Inference SSE chunks are tiny
// per-line and gzip per-line Flush amortises poorly; the SSE
// path leaves gzip off via opts.
const httpRequestUseGzip = true

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
	}
	if err := st.CloseWrite(); err != nil {
		return nil, fmt.Errorf("half-close resource req: %w", err)
	}

	var startResp pbv2.ResourceResponse
	if err := st.ReadMsg(&startResp); err != nil {
		return nil, mapStreamErr(err, "read resource resp")
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

	if err := st.WriteMsg(&pbv2.HTTPRequestStart{
		Method:         req.Method,
		Url:            req.URL,
		Headers:        headersToV2(req.Headers),
		BodySize:       int64(len(req.Body)),
		StreamResponse: false,
	}); err != nil {
		return nil, fmt.Errorf("write http req: %w", err)
	}
	if len(req.Body) > 0 {
		if _, err := st.Writer().Write(req.Body); err != nil {
			return nil, fmt.Errorf("write http body: %w", err)
		}
	}
	if err := st.CloseWrite(); err != nil {
		return nil, fmt.Errorf("half-close http req: %w", err)
	}

	var startResp pbv2.HTTPResponseStart
	if err := st.ReadMsg(&startResp); err != nil {
		return nil, mapStreamErr(err, "read http resp")
	}
	resp := &HTTPResponse{
		Status:  startResp.GetStatus(),
		Headers: headersFromV2(startResp.GetHeaders()),
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
// caller messages. io.EOF from ReadMsg means the worker closed
// the stream before sending a response — usually a worker-side
// crash or a panic in the handler.
func mapStreamErr(err error, what string) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, io.EOF) {
		return fmt.Errorf("%s: worker closed stream early (likely handler panic)", what)
	}
	return fmt.Errorf("%s: %w", what, err)
}
