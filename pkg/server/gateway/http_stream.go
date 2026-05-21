// Package gateway — streaming variant of SendHTTPRequest.
//
// The buffered SendHTTPRequest path (chunked.go) is right for the
// pre-P16 callers (Grafana, VictoriaMetrics, VictoriaLogs) because
// they all want one assembled response. P16-C inference traffic
// breaks that assumption: vLLM `stream: true` emits one SSE event
// per generated token, and the value of the streaming API is gone
// the moment we buffer the entire response before reply.
//
// This file plumbs a parallel path: HTTPStream sessions, keyed by
// request_id like the buffered path but delivering body chunks
// live as they arrive from the worker. The worker side decides
// whether to buffer or stream via the new HTTPRequestStart
// `stream_response` field (defaults to false so the buffered path
// is unchanged for everything else).
//
// Concurrency model:
//   - Caller invokes SendHTTPRequestStream; gateway pre-registers a
//     session keyed by a fresh request_id, then sends
//     HTTPRequestStart with stream_response=true through the
//     worker's prioritySender slow lane.
//   - When the worker replies, the per-worker recv loop in
//     server.go::handleWorkerMessage checks pendingHTTPStream FIRST
//     and dispatches Start / BodyChunk / BodyEnd into the session
//     directly, bypassing the buffered rxAccumulator path.
//   - HTTPResponseStart unblocks the caller (status + headers
//     available); BodyChunk frames are pushed to the session's
//     chunks channel (buffered, see comments below for the
//     back-pressure trade-off); BodyEnd closes the channel and
//     fires endErr.
//
// On disconnect / cleanup: every in-flight session keyed to the
// disconnected worker is force-closed in unregister so callers
// blocked on Chunks unblock immediately rather than hanging on the
// 5-minute upstream timeout.
package gateway

import (
	"context"
	"fmt"
	"log"
	"sync"

	"github.com/google/uuid"

	"github.com/togettoyou/kpilot/pkg/common/proto"
)

// httpStreamChunkBuffer caps the per-session BodyChunk backlog. 32
// frames × 64 KiB/frame = 2 MiB worst-case in-memory queue per active
// stream. SSE traffic is well-behaved (tokens trickle at a few hundred
// bytes / s), so the buffer rarely fills; bulk downloads (non-stream
// chat completions returning megabytes of text in one shot) can fill
// it briefly while the consumer flushes to the browser. If the
// consumer (HTTP handler) stalls beyond this, push() blocks the per-
// worker recv loop — the failure mode is "all this worker's requests
// stall" which is recoverable (consumer eventually drains or HTTP
// connection times out), but visible. Don't enlarge without thinking
// about per-stream memory × concurrent stream count.
const httpStreamChunkBuffer = 32

// HTTPStream is the streaming-variant result handed back to callers
// of SendHTTPRequestStream. Status / Headers / Error are populated
// before SendHTTPRequestStream returns (these come from the
// HTTPResponseStart frame — worker promises to send it before any
// body chunks). Chunks delivers body bytes in order; the channel is
// closed by the gateway when the worker emits BodyEnd. EndErr fires
// once after Chunks closes — empty / nil = clean EOF, non-empty =
// upstream connection failed mid-body (truncated response).
//
// Caller pattern:
//
//	stream, err := gw.SendHTTPRequestStream(ctx, clusterID, req)
//	if err != nil { return err }
//	defer stream.Close()
//	if stream.Error != "" { return fmt.Errorf("upstream: %s", stream.Error) }
//	// write headers / status to response
//	for chunk := range stream.Chunks {
//	    // forward chunk + flush
//	}
//	if err := <-stream.EndErr; err != nil {
//	    // upstream truncation — log; client may have already
//	    // gotten a partial response.
//	}
//
// Close MUST be called (defer is fine) so the gateway releases the
// session-tracking state even if the caller returns early. Calling
// Close before all chunks drain is fine — the session removes itself
// from the registry and subsequent BodyChunk / BodyEnd frames for
// this request_id become orphans and are silently dropped.
type HTTPStream struct {
	Status  int32
	Headers []*proto.HTTPHeader
	Error   string

	Chunks <-chan []byte
	EndErr <-chan error

	closeOnce sync.Once
	gw        *GatewayServer
	requestID string
	sess      *httpStreamSession
}

// Close releases the session-tracking state and tells the worker to
// stop reading from upstream. Idempotent. Late chunks for this
// requestID after Close are orphans and dropped silently.
//
// Sends an HttpCancel frame BEFORE clearing local state so the
// worker sees a valid in-flight request to cancel. Best-effort: if
// the worker disconnected, sendSlow returns ErrSenderClosed and we
// move on — gateway's unregister already force-closed our session
// in that path via closeWorkerHTTPStreams.
func (s *HTTPStream) Close() {
	s.closeOnce.Do(func() {
		log.Printf("[diag-gw] HTTPStream.Close cluster=%s request=%s", s.sess.clusterID, s.requestID)
		if w, ok := s.gw.GetWorker(s.sess.clusterID); ok && w.sender != nil {
			err := w.sender.sendSlow(context.Background(), &proto.ServerMessage{
				RequestId: s.requestID,
				Payload: &proto.ServerMessage_HttpCancel{
					HttpCancel: &proto.HTTPCancelRequest{
						Reason: "stream closed by server",
					},
				},
			})
			log.Printf("[diag-gw] HttpCancel sent cluster=%s request=%s err=%v", s.sess.clusterID, s.requestID, err)
		} else {
			log.Printf("[diag-gw] HttpCancel skipped (worker gone) cluster=%s request=%s", s.sess.clusterID, s.requestID)
		}
		s.gw.removeHTTPStream(s.requestID)
		s.sess.close()
		log.Printf("[diag-gw] HTTPStream.Close done request=%s", s.requestID)
	})
}

// httpStreamSession is the gateway-internal state for one in-flight
// stream. started signals HTTPResponseStart arrived (so the caller of
// SendHTTPRequestStream unblocks with Status/Headers populated).
// chunks gets the body bytes from each BodyChunk frame; endErr fires
// once after BodyEnd. closeCh signals the session is torn down so the
// push() helper doesn't block forever on a wedged consumer.
//
// clusterID is the owning worker's cluster id — used by
// closeWorkerHTTPStreams so a disconnect of cluster B doesn't tear
// down cluster A's in-flight streams. Set once at session creation
// (immutable for the rest of its life).
type httpStreamSession struct {
	clusterID string

	startedOnce sync.Once
	started     chan struct{}
	start       *proto.HTTPResponseStart

	chunks chan []byte
	endErr chan error

	closeOnce sync.Once
	closeCh   chan struct{}
}

func newHTTPStreamSession(clusterID string) *httpStreamSession {
	return &httpStreamSession{
		clusterID: clusterID,
		started:   make(chan struct{}),
		chunks:    make(chan []byte, httpStreamChunkBuffer),
		endErr:    make(chan error, 1),
		closeCh:   make(chan struct{}),
	}
}

// markStarted records the HTTPResponseStart payload and closes the
// started channel exactly once. Guards against worker bugs that
// could re-emit Start for the same request_id — a naive
// `close(started)` would panic the recv goroutine in that case.
// Returns true on the first call, false on subsequent calls (caller
// can log the dup if it cares).
func (s *httpStreamSession) markStarted(start *proto.HTTPResponseStart) bool {
	fired := false
	s.startedOnce.Do(func() {
		s.start = start
		close(s.started)
		fired = true
	})
	return fired
}

// close tears down the session — closes the closeCh (so push() exits
// even if the consumer stalled), closes chunks (so consumers ranging
// on it exit), and best-effort fires endErr with an aborted reason
// (so a consumer that wasn't blocked on Chunks yet still wakes up
// from <-EndErr).
func (s *httpStreamSession) close() {
	s.closeOnce.Do(func() {
		close(s.closeCh)
		close(s.chunks)
		select {
		case s.endErr <- fmt.Errorf("stream closed before BodyEnd"):
		default:
		}
		close(s.endErr)
	})
}

// push forwards one body chunk to the consumer. Blocks until either
// the chunk is accepted OR the session is closed; returns true on
// successful enqueue, false if dropped (session torn down). The recv
// loop calls push from the per-worker recv goroutine — when push
// blocks waiting for chunks-channel headroom, that one worker's
// stream of incoming frames pauses; other workers are unaffected.
func (s *httpStreamSession) push(data []byte) bool {
	select {
	case s.chunks <- data:
		return true
	case <-s.closeCh:
		return false
	}
}

// finalize closes the chunks channel and fires endErr. Idempotent
// via closeOnce — late BodyEnd frames after a forced Close are no-ops.
func (s *httpStreamSession) finalize(endErrMsg string) {
	s.closeOnce.Do(func() {
		close(s.closeCh)
		close(s.chunks)
		var err error
		if endErrMsg != "" {
			err = fmt.Errorf("%s", endErrMsg)
		}
		s.endErr <- err
		close(s.endErr)
	})
}

// SendHTTPRequestStream forwards an HTTP request through the worker
// and returns a streaming handle. Block until HTTPResponseStart
// arrives (Status / Headers / Error populated). Body chunks flow
// through HTTPStream.Chunks; BodyEnd closes Chunks and fires
// EndErr.
//
// Caller MUST call HTTPStream.Close (defer) to release session
// state even on the success path.
//
// Returns error pre-Start for: cluster not connected, ctx
// cancelled, worker disconnected before Start, send-to-worker
// failure on the HTTPRequestStart frame.
func (g *GatewayServer) SendHTTPRequestStream(ctx context.Context, clusterID string, req *HTTPRequest) (*HTTPStream, error) {
	w, ok := g.GetWorker(clusterID)
	if !ok {
		return nil, fmt.Errorf("cluster %s not connected", clusterID)
	}

	requestID := uuid.New().String()
	sess := newHTTPStreamSession(clusterID)

	g.httpStreamMu.Lock()
	g.httpStreams[requestID] = sess
	g.httpStreamMu.Unlock()

	if err := sendChunkedHTTPRequest(ctx, w, requestID, req.Method, req.URL, req.Headers, req.Body, true); err != nil {
		g.removeHTTPStream(requestID)
		sess.close()
		return nil, fmt.Errorf("send to worker: %w", err)
	}

	// Wait for HTTPResponseStart. Status + Headers are needed before
	// the caller can write its own response headers / status, so we
	// can't return until then.
	select {
	case <-sess.started:
		return &HTTPStream{
			Status:    sess.start.Status,
			Headers:   sess.start.Headers,
			Error:     sess.start.Error,
			Chunks:    sess.chunks,
			EndErr:    sess.endErr,
			gw:        g,
			requestID: requestID,
			sess:      sess,
		}, nil
	case <-ctx.Done():
		g.removeHTTPStream(requestID)
		sess.close()
		return nil, ctx.Err()
	case <-w.Stream.Context().Done():
		g.removeHTTPStream(requestID)
		sess.close()
		return nil, fmt.Errorf("worker disconnected: cluster=%s", clusterID)
	}
}

// removeHTTPStream unregisters the session keyed by requestID. Safe
// to call multiple times; second + subsequent calls are no-ops.
func (g *GatewayServer) removeHTTPStream(requestID string) {
	g.httpStreamMu.Lock()
	delete(g.httpStreams, requestID)
	g.httpStreamMu.Unlock()
}

// getHTTPStream looks up the session for requestID without removing
// it. The recv loop uses this on HTTPResponseStart / BodyChunk to
// decide whether to dispatch to streaming vs the buffered
// rxAccumulator path.
func (g *GatewayServer) getHTTPStream(requestID string) (*httpStreamSession, bool) {
	g.httpStreamMu.Lock()
	defer g.httpStreamMu.Unlock()
	sess, ok := g.httpStreams[requestID]
	return sess, ok
}

// takeHTTPStream looks up and removes the session for requestID.
// Used on BodyEnd so subsequent stray frames for this requestID can't
// hit the wrong handler.
func (g *GatewayServer) takeHTTPStream(requestID string) (*httpStreamSession, bool) {
	g.httpStreamMu.Lock()
	defer g.httpStreamMu.Unlock()
	sess, ok := g.httpStreams[requestID]
	if ok {
		delete(g.httpStreams, requestID)
	}
	return sess, ok
}

// closeWorkerHTTPStreams force-closes every in-flight session owned
// by the disconnecting worker. Called from unregister so callers
// blocked on Chunks / EndErr for THIS cluster unblock with the
// synthetic "stream closed" error rather than hanging until upstream
// timeout.
//
// Filters by session.clusterID — a previous draft of this code
// drained the whole table on every disconnect, which clobbered
// other clusters' in-flight streams. Now strictly scoped: only
// matching cluster sessions get closed + removed; other clusters
// stay untouched.
func (g *GatewayServer) closeWorkerHTTPStreams(clusterID string) {
	g.httpStreamMu.Lock()
	victims := make([]*httpStreamSession, 0)
	for reqID, sess := range g.httpStreams {
		if sess.clusterID == clusterID {
			victims = append(victims, sess)
			delete(g.httpStreams, reqID)
		}
	}
	g.httpStreamMu.Unlock()
	for _, sess := range victims {
		sess.close()
	}
}
