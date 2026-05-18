package tunnel

import (
	"context"
	"errors"

	"github.com/togettoyou/kpilot/pkg/common/proto"
)

// chunkSize bounds a single BodyChunk's data field. Picked to keep each
// stream.Send call short on the wire (~one HTTP/2 flow-control round-trip
// at default window sizes) so the sender's loop releases between chunks
// and high-priority frames (Heartbeat) can interleave.
const chunkSize = 256 * 1024

// fastLaneBuf / slowLaneBuf size the per-stream send channels. Fast lane
// only carries Heartbeat (one per 10s); 16 buffers a few seconds of
// backlog on the unlikely event of a transient stall. Slow lane carries
// everything else — chunked response bodies during a busy reverse-proxy
// burst can briefly queue dozens of frames per request, so a larger
// buffer absorbs the spike without producer-side blocking.
const (
	fastLaneBuf = 16
	slowLaneBuf = 1024
)

// ErrSenderClosed is returned by send* methods when the prioritySender's
// loop has exited (typically because stream.Send returned an error or the
// stream's ctx was cancelled). Callers should treat this as "tunnel down,
// drop the frame" — reconnect logic will rebuild the sender from scratch.
var ErrSenderClosed = errors.New("tunnel sender closed")

// prioritySender owns the single goroutine that calls stream.Send. It
// drains a fast lane (Heartbeat) before a slow lane (everything else),
// guaranteeing that a long burst of data frames never starves the
// liveness signal. Producers push frames via sendFast / sendSlow from
// any goroutine — the sender is the only Send caller, so there's no
// sendMu and no concurrent-Send hazard.
//
// Lifetime: one prioritySender per gRPC stream. On stream close (any
// reason) run() returns and the closed `done` channel signals to all
// queued / future producers that the lane is gone.
type prioritySender struct {
	fast chan *proto.WorkerMessage
	slow chan *proto.WorkerMessage
	done chan struct{}
}

func newPrioritySender() *prioritySender {
	return &prioritySender{
		fast: make(chan *proto.WorkerMessage, fastLaneBuf),
		slow: make(chan *proto.WorkerMessage, slowLaneBuf),
		done: make(chan struct{}),
	}
}

// run is the single Send caller. Exits on ctx done or first stream.Send
// error (the error is returned so the outer connect loop can log and
// reconnect). `done` is closed unconditionally so producers blocked on
// send* unblock immediately.
func (s *prioritySender) run(ctx context.Context, stream proto.PilotService_ConnectClient) error {
	defer close(s.done)
	for {
		// Drain fast lane to empty before considering slow.
		select {
		case <-ctx.Done():
			return ctx.Err()
		case msg := <-s.fast:
			if err := stream.Send(msg); err != nil {
				return err
			}
			continue
		default:
		}
		// Fast lane empty: wait for either lane (still prioritises fast
		// when both fire simultaneously because we re-check at loop top).
		select {
		case <-ctx.Done():
			return ctx.Err()
		case msg := <-s.fast:
			if err := stream.Send(msg); err != nil {
				return err
			}
		case msg := <-s.slow:
			if err := stream.Send(msg); err != nil {
				return err
			}
		}
	}
}

// sendFast enqueues a high-priority (Heartbeat) frame. Blocks only if
// the fast lane is full (very rare) or until the stream goes down.
func (s *prioritySender) sendFast(ctx context.Context, msg *proto.WorkerMessage) error {
	select {
	case s.fast <- msg:
		return nil
	case <-s.done:
		return ErrSenderClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}

// sendSlow enqueues any non-Heartbeat frame (Register, PluginStatus,
// LogsChunk, BodyChunk, BodyEnd, etc.). Blocks until queued, the stream
// dies, or the caller's ctx is cancelled.
func (s *prioritySender) sendSlow(ctx context.Context, msg *proto.WorkerMessage) error {
	select {
	case s.slow <- msg:
		return nil
	case <-s.done:
		return ErrSenderClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}
