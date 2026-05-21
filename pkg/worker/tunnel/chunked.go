package tunnel

import (
	"context"
	"fmt"
	"sync"

	"github.com/togettoyou/kpilot/pkg/common/proto"
)

// Worker-side chunked transport.
//
// The wire format for HTTPRequest / ResourceRequest / PluginCommand is
//   *Start  (small metadata frame)
//   BodyChunk (zero or more; each ≤ chunkSize)
//   BodyEnd  (terminator; error string non-empty if sender hit a body-read error)
//
// Receiver-side: per-request_id accumulator opened by *Start, fed by
// BodyChunk, finalised by BodyEnd — at finalisation the assembled
// request is handed to the registered handler in a fresh goroutine.
//
// Sender-side (HTTPResponse / ResourceResponse): chunkedSend* helpers
// split body bytes into BodyChunk frames and emit Start / BodyEnd
// envelopes. All frames go through the prioritySender's slow lane so
// Heartbeat is never blocked.

// HTTPRequest is the assembled HTTP reverse-proxy request received from
// Server. Body is nil for GET/HEAD or empty bodies.
type HTTPRequest struct {
	Method  string
	URL     string
	Headers []*proto.HTTPHeader
	Body    []byte
	// StreamResponse signals the response body should be forwarded
	// live as BodyChunk frames (Start + chunks + End) instead of being
	// fully buffered before reply. Set by P16-C inference proxy paths
	// for vLLM SSE; default false retains P14 buffered semantics for
	// Grafana / VictoriaMetrics / VL etc.
	StreamResponse bool
}

// ResourceRequest is the assembled K8s resource action received from
// Server. Body is non-nil for apply / update / patch; nil for
// list / get / delete / describe.
type ResourceRequest struct {
	Action        string
	Group         string
	Version       string
	Kind          string
	Namespace     string
	Name          string
	Body          []byte
	Limit         int64
	ContinueToken string
	LabelSelector string
}

// PluginCommand is the assembled Helm plugin operation received from
// Server. ChartBlob is non-nil iff Spec.Chart.HasBlob — Worker should
// write it to disk by sha256 before invoking the reconciler.
type PluginCommand struct {
	Action    string
	CrdName   string
	Spec      *proto.PluginSpec
	ChartBlob []byte
}

// requestKind tags which assembler is open for a given request_id.
type requestKind int

const (
	kindHTTP requestKind = iota + 1
	kindResource
	kindPlugin
)

// inboundAssembler accumulates BodyChunk frames for one in-flight
// request whose Start frame already arrived. Single-producer (the
// recv-dispatcher), so no internal mutex.
type inboundAssembler struct {
	kind   requestKind
	start  any   // *proto.HTTPRequestStart / *proto.ResourceRequestStart / *proto.PluginCommandStart
	body   []byte
	failed string // populated by BodyEnd.error; if set, handler is invoked but with empty body
}

// rxAssemblers tracks per-request_id state for inbound chunked
// requests. Worker-wide singleton — the gRPC recv loop is single-
// goroutine so reads / mutations need no lock, but we still guard
// because future per-request goroutines might race on cleanup.
type rxAssemblers struct {
	mu  sync.Mutex
	tab map[string]*inboundAssembler
}

func newRxAssemblers() *rxAssemblers {
	return &rxAssemblers{tab: make(map[string]*inboundAssembler)}
}

// open registers a new accumulator for requestID. Returns false if one
// was already open — sender bug, frame is dropped by caller.
func (r *rxAssemblers) open(requestID string, kind requestKind, start any) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.tab[requestID]; exists {
		return false
	}
	r.tab[requestID] = &inboundAssembler{kind: kind, start: start}
	return true
}

// appendChunk pushes more body bytes; returns false if no assembler is
// open for requestID (orphan chunk — silently drop).
func (r *rxAssemblers) appendChunk(requestID string, data []byte) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	a, ok := r.tab[requestID]
	if !ok {
		return false
	}
	a.body = append(a.body, data...)
	return true
}

// finalize removes and returns the accumulator for requestID. Returns
// nil if not found (orphan End frame).
func (r *rxAssemblers) finalize(requestID string, endErr string) *inboundAssembler {
	r.mu.Lock()
	defer r.mu.Unlock()
	a, ok := r.tab[requestID]
	if !ok {
		return nil
	}
	delete(r.tab, requestID)
	if endErr != "" {
		a.failed = endErr
	}
	return a
}

// drop removes the assembler for requestID without invoking handler —
// used when the stream goes down and we don't want stale state across
// reconnects.
func (r *rxAssemblers) drop(requestID string) {
	r.mu.Lock()
	delete(r.tab, requestID)
	r.mu.Unlock()
}

// reset removes all accumulators (called on disconnect).
func (r *rxAssemblers) reset() {
	r.mu.Lock()
	r.tab = make(map[string]*inboundAssembler)
	r.mu.Unlock()
}

// ────────────────────────────────────────────────────────────────────────
// Outbound chunked senders (Worker → Server)
// ────────────────────────────────────────────────────────────────────────

// sendChunkedHTTPResponse emits HTTPResponseStart + BodyChunk* + BodyEnd
// for a single reverse-proxy response. All frames go on the slow lane so
// Heartbeat is never blocked. body may be nil/empty (BodyEnd with zero
// chunks).
func (c *Client) sendChunkedHTTPResponse(
	ctx context.Context,
	requestID string,
	status int32,
	headers []*proto.HTTPHeader,
	body []byte,
	errMsg string,
) error {
	if err := c.sendHTTPResponseStart(ctx, requestID, status, headers, errMsg); err != nil {
		return err
	}
	sender := c.currentSender()
	if sender == nil {
		return fmt.Errorf("tunnel not connected")
	}
	if err := sendBodyChunks(ctx, sender, requestID, body); err != nil {
		return err
	}
	return c.sendHTTPResponseEnd(ctx, requestID, "")
}

// sendHTTPResponseStart emits ONLY the HTTPResponseStart frame —
// callers that want to stream the body in pieces (P16-C SSE pass-
// through) drive their own BodyChunk + BodyEnd cadence.
func (c *Client) sendHTTPResponseStart(
	ctx context.Context,
	requestID string,
	status int32,
	headers []*proto.HTTPHeader,
	errMsg string,
) error {
	sender := c.currentSender()
	if sender == nil {
		return fmt.Errorf("tunnel not connected")
	}
	return sender.sendSlow(ctx, &proto.WorkerMessage{
		RequestId: requestID,
		Payload: &proto.WorkerMessage_HttpRespStart{
			HttpRespStart: &proto.HTTPResponseStart{
				Status:  status,
				Headers: headers,
				Error:   errMsg,
			},
		},
	})
}

// sendHTTPResponseChunk emits ONE BodyChunk for a streaming HTTP
// response. data must be a freshly-allocated slice (caller doesn't
// reuse the underlying array); the sender retains the reference until
// the slow-lane drains the frame.
func (c *Client) sendHTTPResponseChunk(
	ctx context.Context,
	requestID string,
	data []byte,
) error {
	if len(data) == 0 {
		return nil
	}
	sender := c.currentSender()
	if sender == nil {
		return fmt.Errorf("tunnel not connected")
	}
	// Split into ≤chunkSize frames if the caller handed us a bigger
	// buffer. Streaming readers typically use small (~32 KiB) reads so
	// this is usually a single iteration.
	return sendBodyChunks(ctx, sender, requestID, data)
}

// sendHTTPResponseEnd emits BodyEnd to close a streaming HTTP
// response. errMsg is empty on clean EOF; non-empty when the upstream
// connection failed mid-body (gateway surfaces it to its caller so
// the partial response isn't mistaken for a clean termination).
func (c *Client) sendHTTPResponseEnd(
	ctx context.Context,
	requestID string,
	errMsg string,
) error {
	sender := c.currentSender()
	if sender == nil {
		return fmt.Errorf("tunnel not connected")
	}
	return sender.sendSlow(ctx, &proto.WorkerMessage{
		RequestId: requestID,
		Payload: &proto.WorkerMessage_BodyEnd{
			BodyEnd: &proto.BodyEnd{Error: errMsg},
		},
	})
}

// sendChunkedResourceResponse emits ResourceResponseStart + BodyChunk* +
// BodyEnd for a K8s proxy response. data is nil/empty for success-with-
// no-payload (delete / patch with no return).
func (c *Client) sendChunkedResourceResponse(
	ctx context.Context,
	requestID string,
	success bool,
	errMsg string,
	data []byte,
) error {
	sender := c.currentSender()
	if sender == nil {
		return fmt.Errorf("tunnel not connected")
	}
	if err := sender.sendSlow(ctx, &proto.WorkerMessage{
		RequestId: requestID,
		Payload: &proto.WorkerMessage_ResourceRespStart{
			ResourceRespStart: &proto.ResourceResponseStart{
				Success: success,
				Error:   errMsg,
			},
		},
	}); err != nil {
		return err
	}
	if err := sendBodyChunks(ctx, sender, requestID, data); err != nil {
		return err
	}
	return sender.sendSlow(ctx, &proto.WorkerMessage{
		RequestId: requestID,
		Payload: &proto.WorkerMessage_BodyEnd{
			BodyEnd: &proto.BodyEnd{},
		},
	})
}

// sendBodyChunks splits body into ≤chunkSize-byte BodyChunk frames and
// enqueues them on the slow lane in order. Empty body emits no chunks.
// Slices share storage with `body` — all callers pass fresh allocations
// (io.ReadAll / json.Marshal output) that aren't mutated downstream, so
// the slice references stay valid until the sender drains them. Avoids
// duplicating ~response-size bytes per send (significant for chart
// blobs and large list-full payloads).
func sendBodyChunks(ctx context.Context, sender *prioritySender, requestID string, body []byte) error {
	for offset := 0; offset < len(body); offset += chunkSize {
		end := offset + chunkSize
		if end > len(body) {
			end = len(body)
		}
		if err := sender.sendSlow(ctx, &proto.WorkerMessage{
			RequestId: requestID,
			Payload: &proto.WorkerMessage_BodyChunk{
				BodyChunk: &proto.BodyChunk{Data: body[offset:end]},
			},
		}); err != nil {
			return err
		}
	}
	return nil
}
