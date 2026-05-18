package tunnel

import (
	"context"
	"errors"
	"sync"

	"github.com/togettoyou/kpilot/pkg/common/proto"
)

// chunkSize bounds a single BodyChunk's data field. Two competing
// concerns shape this:
//
//   - Larger chunks amortise per-frame gRPC envelope overhead (~50
//     bytes of protobuf + HTTP/2 framing) and let gzip compress with
//     a fuller dictionary, so the wire is more efficient byte-for-
//     byte.
//   - Smaller chunks cap the wire time of a single "turn" in the
//     fair-scheduling round-robin. Under cross-WAN bandwidth (~60
//     KB/s observed against managed-ingress endpoints), a 256 KiB
//     chunk takes ~4 s to traverse the wire, which means a small
//     concurrent request waiting for its next round-robin slot has
//     to wait that long per remaining interleaved chunk it needs to
//     compete with. Dropping to 64 KiB cuts that per-slot wait to
//     ~1 s — the difference between "feels frozen for several
//     seconds" and "feels responsive" under a heavy concurrent log
//     query.
//
// The 4× more frames cost an extra ~1% in wire bytes (overhead is
// negligible relative to body bytes), modestly more CPU for framing
// and scheduling, and gzip compresses slightly less tightly per
// frame (~5–10% efficiency hit on highly redundant JSON). All worth
// it for the latency win on slow links.
const chunkSize = 64 * 1024

// fastLaneBuf sizes the Heartbeat-only fast lane. One Heartbeat per
// 10 s; a 16-slot buffer absorbs unlikely transient stalls.
const fastLaneBuf = 16

// ErrSenderClosed is returned by send* methods when the prioritySender's
// loop has exited (typically because stream.Send returned an error or the
// stream's ctx was cancelled). Callers should treat this as "tunnel down,
// drop the frame" — reconnect logic will rebuild the sender from scratch.
var ErrSenderClosed = errors.New("tunnel sender closed")

// slowQueue holds frames pending for one logical stream key (typically
// the message's request_id; empty key = singleton "control" bucket for
// frames with no request_id — Heartbeat is on the fast lane, but
// RegisterAck / PluginStatus / PluginLogEnd land here).
//
// FIFO within the queue — chunks of one response stay in order. The
// scheduler interleaves across queues; receivers demux by request_id
// via rxAssemblers so wire-level interleaving is transparent.
type slowQueue struct {
	key  string
	msgs []*proto.WorkerMessage
}

// prioritySender owns the single goroutine that calls stream.Send.
//
// Two lanes:
//   - fast: Heartbeat only, drained to empty before slow is considered.
//   - slow: per-key sub-queues drained round-robin. Replaces the older
//     single-FIFO design where one large response (e.g. a 20 MiB logs
//     payload chunked into ~80 frames) would head-of-line block every
//     other in-flight request's response chunks until it fully drained
//     over the network — catastrophic on cross-WAN tunnels where the
//     drain takes minutes.
//
// Round-robin scheduling guarantees that a small response queued behind
// a large one waits at most (1 + per-queue chunk count) × per-chunk-RTT
// instead of (large-response chunk count) × per-chunk-RTT.
//
// Producers push frames via sendFast / sendSlow from any goroutine; the
// sender is the only stream.Send caller, so there's no concurrent-Send
// hazard and no sendMu on the gRPC stream itself.
//
// Lifetime: one prioritySender per gRPC stream. On stream close (any
// reason) run() returns and the closed `done` channel signals to all
// queued / future producers that the lane is gone.
type prioritySender struct {
	fast chan *proto.WorkerMessage

	mu     sync.Mutex
	queues map[string]*slowQueue // key → queue (lookup)
	order  []*slowQueue          // round-robin order (iteration)
	cursor int                   // next index in `order` to serve

	// wake is a buf=1 channel a producer signals after appending to
	// slow lane, so the sender goroutine unblocks from its idle wait.
	// Buffered, non-blocking send: extra signals collapse into one
	// (sender will check the lane anyway on its next loop).
	wake chan struct{}
	done chan struct{}
}

func newPrioritySender() *prioritySender {
	return &prioritySender{
		fast:   make(chan *proto.WorkerMessage, fastLaneBuf),
		queues: make(map[string]*slowQueue),
		wake:   make(chan struct{}, 1),
		done:   make(chan struct{}),
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
// returns it. Returns nil when all sub-queues are empty.
//
// Bookkeeping after pop:
//   - if the served queue still has frames, cursor advances by one;
//   - if the served queue is now empty, it's removed from order/queues
//     and cursor is rebased onto the new order so the next call serves
//     the queue that was previously at cursor+1.
func (s *prioritySender) nextSlow() *proto.WorkerMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(s.order)
	if n == 0 {
		return nil
	}
	// Walk at most n positions starting at cursor — first non-empty
	// queue wins. Defensive: in practice all queues in `order` are
	// non-empty (drained queues are removed below), so this loop
	// finds the first match on the first iteration.
	for i := 0; i < n; i++ {
		idx := (s.cursor + i) % n
		q := s.order[idx]
		if len(q.msgs) == 0 {
			continue
		}
		msg := q.msgs[0]
		q.msgs = q.msgs[1:]
		if len(q.msgs) == 0 {
			// Drained — drop from queues map and remove from order.
			// The "next" slot logically was idx+1 in the old order,
			// which becomes idx in the new (shorter) order. Mod by
			// the new length wraps the end-of-list case.
			delete(s.queues, q.key)
			s.order = append(s.order[:idx], s.order[idx+1:]...)
			if len(s.order) == 0 {
				s.cursor = 0
			} else {
				s.cursor = idx % len(s.order)
			}
		} else {
			// Advance one position, wrapping at the end.
			s.cursor = (idx + 1) % n
		}
		return msg
	}
	return nil
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

// sendSlow appends msg to the sub-queue for its request_id (empty key
// for non-keyed control frames). Returns immediately after the in-memory
// append — no per-frame backpressure on the producer; HOL across logical
// requests is prevented by the round-robin drain.
//
// Memory bound: each chunked request body is capped (proxyMaxRespBytes
// = 31 MiB on the HTTP proxy path, similar for ResourceResponse and
// chart blobs), so a single sub-queue holds at most ~124 chunks
// (31 MiB / 256 KiB). With N concurrent requests in flight worst case
// is N × 31 MiB — comfortable for any realistic worker pod size.
func (s *prioritySender) sendSlow(ctx context.Context, msg *proto.WorkerMessage) error {
	// Cheap check first — avoid acquiring mu if the sender is gone.
	select {
	case <-s.done:
		return ErrSenderClosed
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	key := msg.RequestId // "" for non-keyed control frames; that's a valid distinct key
	s.mu.Lock()
	q, ok := s.queues[key]
	if !ok {
		q = &slowQueue{key: key}
		s.queues[key] = q
		s.order = append(s.order, q)
	}
	q.msgs = append(q.msgs, msg)
	s.mu.Unlock()

	// Poke the sender. Non-blocking — wake is buf=1, extra signals
	// collapse because the sender re-checks both lanes after every
	// wake anyway.
	select {
	case s.wake <- struct{}{}:
	default:
	}

	return nil
}
