package gateway

import (
	"context"
	"fmt"
	"log"
	"sync"

	"github.com/google/uuid"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/pluginservice"
)

// Server-side chunked transport mirror of pkg/worker/tunnel/chunked.go.
//
// Outbound (Server → Worker): HTTPRequest, ResourceRequest, PluginCommand
// all go out as *Start + BodyChunk* + BodyEnd on the prioritySender's
// slow lane.
//
// Inbound (Worker → Server): HTTPResponseStart / ResourceResponseStart
// open per-request accumulators on the owning ConnectedWorker; BodyChunk
// appends; BodyEnd finalises and delivers to the pending response
// channel registered by SendHTTPRequest / SendResourceRequest.

// HTTPRequest is the high-level shape handlers pass to SendHTTPRequest.
// Body bytes are chunked over the wire — handlers don't need to think
// about framing.
type HTTPRequest struct {
	Method  string
	URL     string
	Headers []*proto.HTTPHeader
	Body    []byte
	// StreamResponse asks the worker to forward upstream body bytes
	// live as BodyChunk frames rather than buffering the full response
	// before reply. SendHTTPRequestStream sets this; the unary
	// SendHTTPRequest leaves it false so existing buffered callers
	// (Grafana / VM / VL queries) are unaffected.
	StreamResponse bool
}

// HTTPResponse is the assembled reverse-proxy response delivered to
// SendHTTPRequest callers. Body is nil/empty on 204 / dispatch error.
type HTTPResponse struct {
	Status  int32
	Headers []*proto.HTTPHeader
	Body    []byte
	Error   string
}

// ResourceRequest is the high-level shape handlers pass to
// SendResourceRequest. Mirrors the field set of the wire-level
// ResourceRequestStart plus Body — gateway extracts Body and streams
// it as BodyChunk frames so a multi-megabyte Apply YAML never starves
// Heartbeat.
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

// ResourceResponse is the assembled K8s proxy response delivered to
// SendResourceRequest callers.
type ResourceResponse struct {
	Success bool
	Error   string
	Data    []byte
}

type rxKind int

const (
	rxKindHTTP rxKind = iota + 1
	rxKindResource
)

type rxAccumulator struct {
	kind  rxKind
	start any // *proto.HTTPResponseStart or *proto.ResourceResponseStart
	body  []byte
}

// rxAccumulators holds per-request_id inbound state for one worker.
// Recv-loop is single-goroutine per worker so contention is low, but we
// still guard because cleanup (on worker disconnect) and finalise (on
// BodyEnd) may interleave in pathological races.
type rxAccumulators struct {
	mu  sync.Mutex
	tab map[string]*rxAccumulator
}

func newRxAccumulators() *rxAccumulators {
	return &rxAccumulators{tab: make(map[string]*rxAccumulator)}
}

func (r *rxAccumulators) open(requestID string, kind rxKind, start any) {
	r.mu.Lock()
	if _, exists := r.tab[requestID]; exists {
		// Should be impossible — server generates a fresh UUID for each
		// outbound request. A collision means either uuid pkg broke or
		// worker is sending duplicate Start frames; either way the prior
		// accumulator (and any chunks already received for it) gets
		// orphaned. Log so we notice if it ever happens in practice.
		log.Printf("[gateway] chunked accumulator collision (overwriting prior): request=%s kind=%d", requestID, kind)
	}
	r.tab[requestID] = &rxAccumulator{kind: kind, start: start}
	r.mu.Unlock()
}

func (r *rxAccumulators) appendChunk(requestID string, data []byte) {
	r.mu.Lock()
	if a, ok := r.tab[requestID]; ok {
		a.body = append(a.body, data...)
	}
	r.mu.Unlock()
}

func (r *rxAccumulators) finalize(requestID string) *rxAccumulator {
	r.mu.Lock()
	defer r.mu.Unlock()
	a, ok := r.tab[requestID]
	if !ok {
		return nil
	}
	delete(r.tab, requestID)
	return a
}

func (r *rxAccumulators) reset() {
	r.mu.Lock()
	r.tab = make(map[string]*rxAccumulator)
	r.mu.Unlock()
}

// ────────────────────────────────────────────────────────────────────────
// Outbound chunked senders (Server → Worker)
// ────────────────────────────────────────────────────────────────────────

// sendChunkedHTTPRequest emits HTTPRequestStart + BodyChunk* + BodyEnd
// to the worker through its prioritySender's slow lane. Body may be nil
// (GET/HEAD); zero chunks are emitted in that case and BodyEnd closes.
// streamResponse=true tells the worker to forward the upstream response
// body live (P16-C SSE pass-through) instead of buffering.
func sendChunkedHTTPRequest(ctx context.Context, w *ConnectedWorker, requestID, method, url string, headers []*proto.HTTPHeader, body []byte, streamResponse bool) error {
	if w.sender == nil {
		return fmt.Errorf("worker sender not ready")
	}
	if err := w.sender.sendSlow(ctx, &proto.ServerMessage{
		RequestId: requestID,
		Payload: &proto.ServerMessage_HttpReqStart{
			HttpReqStart: &proto.HTTPRequestStart{
				Method:         method,
				Url:            url,
				Headers:        headers,
				StreamResponse: streamResponse,
			},
		},
	}); err != nil {
		return err
	}
	if err := serverSendBodyChunks(ctx, w, requestID, body); err != nil {
		return err
	}
	return w.sender.sendSlow(ctx, &proto.ServerMessage{
		RequestId: requestID,
		Payload: &proto.ServerMessage_BodyEnd{
			BodyEnd: &proto.BodyEnd{},
		},
	})
}

// sendChunkedResourceRequest emits ResourceRequestStart + BodyChunk* +
// BodyEnd. body is non-nil for apply/update/patch; nil/empty for
// list/get/delete.
func sendChunkedResourceRequest(ctx context.Context, w *ConnectedWorker, requestID string, req *proto.ResourceRequestStart, body []byte) error {
	if w.sender == nil {
		return fmt.Errorf("worker sender not ready")
	}
	if err := w.sender.sendSlow(ctx, &proto.ServerMessage{
		RequestId: requestID,
		Payload: &proto.ServerMessage_ResourceReqStart{
			ResourceReqStart: req,
		},
	}); err != nil {
		return err
	}
	if err := serverSendBodyChunks(ctx, w, requestID, body); err != nil {
		return err
	}
	return w.sender.sendSlow(ctx, &proto.ServerMessage{
		RequestId: requestID,
		Payload: &proto.ServerMessage_BodyEnd{
			BodyEnd: &proto.BodyEnd{},
		},
	})
}

// sendChunkedPluginCommand emits PluginCommandStart + (if chart blob)
// BodyChunk* + BodyEnd. Worker assembles via rxAsm (keyed by
// request_id) then dispatches to the plugin reconciler. Each
// invocation uses a fresh uuid as request_id so two rapid back-to-back
// commands for the same CRD don't collide on the same accumulator
// (the second open would no-op and the second command would be lost).
func sendChunkedPluginCommand(ctx context.Context, w *ConnectedWorker, cmd *pluginservice.Command) error {
	if w.sender == nil {
		return fmt.Errorf("worker sender not ready")
	}
	requestID := uuid.New().String()
	spec := cmd.Spec
	if spec != nil && spec.Chart != nil {
		spec.Chart.HasBlob = len(cmd.Blob) > 0
	}
	if err := w.sender.sendSlow(ctx, &proto.ServerMessage{
		RequestId: requestID,
		Payload: &proto.ServerMessage_PluginCmdStart{
			PluginCmdStart: &proto.PluginCommandStart{
				Action:  cmd.Action,
				CrdName: cmd.CrdName,
				Spec:    spec,
			},
		},
	}); err != nil {
		return err
	}
	if err := serverSendBodyChunks(ctx, w, requestID, cmd.Blob); err != nil {
		return err
	}
	return w.sender.sendSlow(ctx, &proto.ServerMessage{
		RequestId: requestID,
		Payload: &proto.ServerMessage_BodyEnd{
			BodyEnd: &proto.BodyEnd{},
		},
	})
}

// serverSendBodyChunks splits body into ≤chunkSize-byte BodyChunk frames
// and enqueues them on the slow lane in order. Empty body emits no
// chunks. Slices share storage with `body` — all callers pass fresh
// allocations (io.ReadAll of request body, store.GetPluginBlobByID
// output) that aren't mutated downstream, so the references stay valid
// until the sender drains them. Saves ~body-size bytes per send (50 MiB
// for a chart blob).
func serverSendBodyChunks(ctx context.Context, w *ConnectedWorker, requestID string, body []byte) error {
	for offset := 0; offset < len(body); offset += chunkSize {
		end := offset + chunkSize
		if end > len(body) {
			end = len(body)
		}
		if err := w.sender.sendSlow(ctx, &proto.ServerMessage{
			RequestId: requestID,
			Payload: &proto.ServerMessage_BodyChunk{
				BodyChunk: &proto.BodyChunk{Data: body[offset:end]},
			},
		}); err != nil {
			return err
		}
	}
	return nil
}
