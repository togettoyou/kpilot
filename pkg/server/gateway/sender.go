package gateway

import (
	"context"
	"errors"
	"sync"

	"github.com/togettoyou/kpilot/pkg/common/proto"
)

// chunkSize bounds a single BodyChunk's data field. Mirrors the worker
// side; see pkg/worker/tunnel/sender.go for the latency-vs-overhead
// rationale (64 KiB caps a single round-robin "turn" at ~1 s on a
// ~60 KB/s cross-WAN wire, keeping small concurrent requests
// responsive while a large response streams).
const chunkSize = 64 * 1024

// fastLaneBuf is sized for control frames the server might emit out-
// of-band. Server has no Heartbeat to send today, but the lane exists
// for future control frames that need to bypass the slow round-robin
// (RegisterAck still goes via slow lane to preserve FIFO order with
// frames that might land while the handshake is in flight).
const fastLaneBuf = 16

// ErrSenderClosed is returned by send* methods when the prioritySender's
// loop has exited (typically because stream.Send returned an error or
// the stream context was cancelled). Callers should treat this as
// "worker gone, abandon the frame".
var ErrSenderClosed = errors.New("gateway sender closed")

// slowQueue holds frames pending for one logical stream key (typically
// request_id; empty key = singleton "control" bucket for frames with no
// request_id). FIFO within the queue — chunks of one request stay in
// order; receivers demux by request_id so cross-queue wire interleaving
// is transparent.
type slowQueue struct {
	key  string
	msgs []*proto.ServerMessage
}

// prioritySender owns the single goroutine that calls Stream.Send for
// one ConnectedWorker.
//
// Two lanes:
//   - fast: reserved for future high-priority control frames.
//   - slow: per-key sub-queues drained round-robin. Replaces the older
//     single-FIFO design where one large outbound request (chart blob,
//     large Apply YAML) would head-of-line block every other in-flight
//     request's frames until it fully drained over the network —
//     catastrophic on cross-WAN tunnels where the drain takes minutes.
//
// Round-robin scheduling guarantees that a small request queued behind
// a large one waits at most (1 + per-queue frame count) × per-frame-RTT
// instead of (large-request frame count) × per-frame-RTT.
//
// Producers (HTTP handlers, replay loops, stream session goroutines)
// push frames via sendFast / sendSlow from any goroutine; the sender is
// the only Stream.Send caller, so there's no concurrent-Send hazard
// and no sendMu on the gRPC stream itself.
type prioritySender struct {
	fast chan *proto.ServerMessage

	mu     sync.Mutex
	queues map[string]*slowQueue // key → queue (lookup)
	order  []*slowQueue          // round-robin order (iteration)
	cursor int                   // next index in `order` to serve

	// wake is a buf=1 channel a producer signals after appending to
	// slow lane, so the sender goroutine unblocks from its idle wait.
	wake chan struct{}
	done chan struct{}
}

func newPrioritySender() *prioritySender {
	return &prioritySender{
		fast:   make(chan *proto.ServerMessage, fastLaneBuf),
		queues: make(map[string]*slowQueue),
		wake:   make(chan struct{}, 1),
		done:   make(chan struct{}),
	}
}

// run is the single Send caller for the worker's stream. Exits on ctx
// done or first Send error.
func (s *prioritySender) run(ctx context.Context, stream proto.PilotService_ConnectServer) error {
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

		// Round-robin across slow sub-queues.
		if msg := s.nextSlow(); msg != nil {
			if err := stream.Send(msg); err != nil {
				return err
			}
			continue
		}

		// Both lanes idle: block until a producer wakes us or ctx
		// cancels. Fast-lane delivery during the wait short-circuits
		// the loop top re-check.
		select {
		case <-ctx.Done():
			return ctx.Err()
		case msg := <-s.fast:
			if err := stream.Send(msg); err != nil {
				return err
			}
		case <-s.wake:
			// Loop and re-check both lanes.
		}
	}
}

// nextSlow pops one frame from the slow lane in round-robin order and
// returns it. See worker-side counterpart in pkg/worker/tunnel/sender.go
// for the bookkeeping rationale (cursor rebasing when a queue drains).
func (s *prioritySender) nextSlow() *proto.ServerMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(s.order)
	if n == 0 {
		return nil
	}
	for i := 0; i < n; i++ {
		idx := (s.cursor + i) % n
		q := s.order[idx]
		if len(q.msgs) == 0 {
			continue
		}
		msg := q.msgs[0]
		q.msgs = q.msgs[1:]
		if len(q.msgs) == 0 {
			delete(s.queues, q.key)
			s.order = append(s.order[:idx], s.order[idx+1:]...)
			if len(s.order) == 0 {
				s.cursor = 0
			} else {
				s.cursor = idx % len(s.order)
			}
		} else {
			s.cursor = (idx + 1) % n
		}
		return msg
	}
	return nil
}

// sendFast enqueues a high-priority frame.
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

// sendSlow appends msg to the sub-queue for its request_id (empty key
// for non-keyed control frames like RegisterAck). Returns immediately
// after the append — no per-frame backpressure.
func (s *prioritySender) sendSlow(ctx context.Context, msg *proto.ServerMessage) error {
	select {
	case <-s.done:
		return ErrSenderClosed
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	key := msg.RequestId
	s.mu.Lock()
	q, ok := s.queues[key]
	if !ok {
		q = &slowQueue{key: key}
		s.queues[key] = q
		s.order = append(s.order, q)
	}
	q.msgs = append(q.msgs, msg)
	s.mu.Unlock()

	select {
	case s.wake <- struct{}{}:
	default:
	}

	return nil
}
