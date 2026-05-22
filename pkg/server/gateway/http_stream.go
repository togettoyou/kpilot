// Package gateway — streaming variant of SendHTTPRequest (v2).
//
// HTTPStream wraps a yamux stream: Body is the live response byte
// stream (io.Reader directly off the yamux Stream's Read). Close
// fires the yamux FIN, which propagates to the worker as the
// signal to cancel the upstream HTTP request — replacing v1's
// custom HttpCancel frame + per-write deadline workaround.
//
// vs v1, gone entirely:
//   - per-session chunks/EndErr channels + pump goroutine
//   - httpStreamSession registry / takeHTTPStream / getHTTPStream
//   - closeWorkerHTTPStreams (yamux session.Close cascades)
//   - HttpCancel frame (stream.Close replaces)
//   - markStarted sync.Once (no recv loop = no re-emit risk)
package gateway

import (
	"context"
	"fmt"
	"io"
	"sync"

	"github.com/google/uuid"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	transportv2 "github.com/togettoyou/kpilot/pkg/transport/yamux"
)

// HTTPStream is the streaming-variant result handed back to
// callers of SendHTTPRequestStream. Status / Headers / Error are
// populated before SendHTTPRequestStream returns (read from the
// HTTPResponseStart frame). Body is the live response byte
// stream — caller does io.Copy(dst, stream.Body) to forward.
//
// Caller MUST call Close (defer is fine) — Close sends FIN on
// the yamux stream, which the worker handles as "client gave up,
// abort upstream request now". Without Close the upstream
// connection lingers until the worker's per-request ctx fires.
type HTTPStream struct {
	Status  int32
	Headers []*proto.HTTPHeader
	Error   string

	// Body is the live response stream. Reads block waiting for
	// the worker to forward upstream bytes; returns io.EOF on
	// clean stream close. Closing the underlying yamux stream
	// (via Close) makes subsequent reads return immediately.
	Body io.Reader

	closeOnce sync.Once
	stream    *transportv2.Stream
}

// Close sends yamux FIN. Worker observes this as a cancel signal
// and tears down its upstream HTTP request. Idempotent.
func (s *HTTPStream) Close() {
	s.closeOnce.Do(func() {
		_ = s.stream.Close()
	})
}

// SendHTTPRequestStream opens a STREAM_HTTP_REQUEST stream with
// stream_response=true and reads HTTPResponseStart synchronously;
// returns an HTTPStream whose Body delivers bytes live as the
// worker forwards them off the upstream socket.
//
// Returns error pre-Start for: cluster not connected, ctx
// cancelled, worker disconnected before Start, send-to-worker
// failure on the HTTPRequestStart frame.
//
// Gzip is OFF on this stream — SSE per-line Flushes don't
// amortise gzip well, and the inference path's tokens are tiny
// per-write so the gzip header overhead would dominate.
func (g *GatewayServer) SendHTTPRequestStream(ctx context.Context, clusterID string, req *HTTPRequest) (*HTTPStream, error) {
	w, ok := g.GetWorker(clusterID)
	if !ok {
		return nil, fmt.Errorf("cluster %s not connected", clusterID)
	}
	st, err := w.Session.Open(ctx, pbv2.StreamKind_STREAM_HTTP_REQUEST, uuid.NewString(), false /*gzip*/)
	if err != nil {
		return nil, fmt.Errorf("open http stream: %w", err)
	}
	// On error after Open we Close; on success the caller owns
	// the stream and calls Close themselves.
	closeOnFail := true
	defer func() {
		if closeOnFail {
			_ = st.Close()
		}
	}()
	applyCtxDeadline(ctx, st)

	if err := st.WriteMsg(&pbv2.HTTPRequestStart{
		Method:         req.Method,
		Url:            req.URL,
		Headers:        headersToV2(req.Headers),
		BodySize:       int64(len(req.Body)),
		StreamResponse: true,
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

	closeOnFail = false
	return &HTTPStream{
		Status:  startResp.GetStatus(),
		Headers: headersFromV2(startResp.GetHeaders()),
		Error:   startResp.GetError(),
		Body:    st.Reader(),
		stream:  st,
	}, nil
}
