package gateway

import (
	"context"
	"errors"

	"github.com/togettoyou/kpilot/pkg/common/proto"
)

// chunkSize bounds a single BodyChunk's data field. Mirrors the worker
// side; see pkg/worker/tunnel/sender.go for rationale.
const chunkSize = 256 * 1024

const (
	fastLaneBuf = 16
	slowLaneBuf = 1024
)

// ErrSenderClosed is returned by send* methods when the prioritySender's
// loop has exited (typically because stream.Send returned an error or
// the stream context was cancelled). Callers should treat this as
// "worker gone, abandon the frame".
var ErrSenderClosed = errors.New("gateway sender closed")

// prioritySender owns the single goroutine that calls Stream.Send for
// one ConnectedWorker. Producers (HTTP handlers, replay loops, stream
// session goroutines) push frames via sendFast / sendSlow; the sender
// drains fast lane fully before considering slow lane, guaranteeing
// control frames (Heartbeat ACKs, RegisterAck) never get starved by
// data-plane chunks.
type prioritySender struct {
	fast chan *proto.ServerMessage
	slow chan *proto.ServerMessage
	done chan struct{}
}

func newPrioritySender() *prioritySender {
	return &prioritySender{
		fast: make(chan *proto.ServerMessage, fastLaneBuf),
		slow: make(chan *proto.ServerMessage, slowLaneBuf),
		done: make(chan struct{}),
	}
}

// run is the single Send caller for the worker's stream. Exits on ctx
// done or first Send error.
func (s *prioritySender) run(ctx context.Context, stream proto.PilotService_ConnectServer) error {
	defer close(s.done)
	for {
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

// sendFast enqueues a high-priority frame (currently unused — server
// side has no equivalent to Heartbeat going out; reserved for future
// control acks).
func (s *prioritySender) sendFast(ctx context.Context, msg *proto.ServerMessage) error {
	select {
	case s.fast <- msg:
		return nil
	case <-s.done:
		return ErrSenderClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}

// sendSlow enqueues any data-plane frame (chunked request bodies,
// stream session messages, RegisterAck).
func (s *prioritySender) sendSlow(ctx context.Context, msg *proto.ServerMessage) error {
	select {
	case s.slow <- msg:
		return nil
	case <-s.done:
		return ErrSenderClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}
