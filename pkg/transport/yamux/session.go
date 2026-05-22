package transport

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"

	"github.com/hashicorp/yamux"

	pb "github.com/togettoyou/kpilot/pkg/common/proto/v2"
)

// ErrSessionClosed is returned by Open / Accept after the session
// has terminated (yamux session.CloseChan fired). Callers should
// stop dispatching and unwind.
var ErrSessionClosed = errors.New("transport: session closed")

// Session is a yamux multiplexed connection between server and
// worker. One TLS TCP conn per cluster carries N concurrent yamux
// streams; both peers can OpenStream at will, and yamux handles
// per-stream flow control + cancellation natively.
//
// Worker side wraps a TLS-dialed net.Conn in NewClientSession.
// Server side wraps an accepted net.Conn in NewServerSession.
// After construction, both peers use the same Session API:
//
//   - Open(ctx, kind, requestID, gzip) → outbound RPC
//   - Accept() / AcceptLoop → handle inbound RPCs from the other peer
//   - CloseChan() → fired when the session dies (network drop,
//     keepalive timeout, peer Close, etc); detect and reconnect.
//
// Auth/Register is NOT done by NewClientSession / NewServerSession —
// callers are expected to open a STREAM_REGISTER first thing on the
// client and accept it on the server, exchanging RegisterRequest /
// RegisterAck via WriteMsg / ReadMsg. The session itself is
// auth-agnostic.
type Session struct {
	raw *yamux.Session
}

// NewClientSession wraps a (typically TLS-secured) net.Conn as a
// yamux client session. The client side is the active opener:
// worker dials the server then constructs a client session.
//
// cfg may be nil; defaults from DefaultYamuxConfig are used.
func NewClientSession(conn net.Conn, cfg *yamux.Config) (*Session, error) {
	if cfg == nil {
		cfg = DefaultYamuxConfig()
	}
	s, err := yamux.Client(conn, cfg)
	if err != nil {
		return nil, fmt.Errorf("yamux client: %w", err)
	}
	return &Session{raw: s}, nil
}

// NewServerSession wraps an accepted net.Conn as a yamux server
// session. Used by server.Accept's per-conn goroutine.
func NewServerSession(conn net.Conn, cfg *yamux.Config) (*Session, error) {
	if cfg == nil {
		cfg = DefaultYamuxConfig()
	}
	s, err := yamux.Server(conn, cfg)
	if err != nil {
		return nil, fmt.Errorf("yamux server: %w", err)
	}
	return &Session{raw: s}, nil
}

// Open initiates a new outbound stream and sends the StreamHeader.
// Caller decides the gzip flag — see docs/transport-v2.md §6.3 for
// the default per-kind table (JSON / text → on; binary blob /
// interactive → off).
//
// The context controls only the Open call itself (the yamux SYN +
// header write). Per-stream lifetime deadlines should be set via
// the returned Stream.Raw().SetDeadline.
func (s *Session) Open(ctx context.Context, kind pb.StreamKind, requestID string, gzip bool) (*Stream, error) {
	if s == nil || s.raw == nil {
		return nil, ErrSessionClosed
	}
	type result struct {
		raw *yamux.Stream
		err error
	}
	// yamux.OpenStream doesn't take a ctx; run in a goroutine so
	// ctx cancel can interrupt us. The actual stream will leak
	// briefly (until yamux's own session timeout fires) if ctx
	// fires first; that's bounded and harmless.
	ch := make(chan result, 1)
	go func() {
		ys, err := s.raw.OpenStream()
		ch <- result{ys, err}
	}()
	var raw *yamux.Stream
	select {
	case r := <-ch:
		if r.err != nil {
			if errors.Is(r.err, yamux.ErrSessionShutdown) {
				return nil, ErrSessionClosed
			}
			return nil, fmt.Errorf("open stream: %w", r.err)
		}
		raw = r.raw
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-s.raw.CloseChan():
		return nil, ErrSessionClosed
	}
	hdr := &pb.StreamHeader{
		Kind:      kind,
		RequestId: requestID,
		Gzip:      gzip,
	}
	st, err := openStream(raw, hdr)
	if err != nil {
		return nil, err
	}
	return st, nil
}

// Accept blocks until the peer opens a stream, reads its
// StreamHeader, and returns the wrapped Stream. Returns
// ErrSessionClosed when the session has terminated.
//
// Typical usage on the server / worker side is a goroutine loop:
//
//	for {
//	    st, err := sess.Accept()
//	    if err != nil { return err }   // session is dead, reconnect / exit
//	    go handleStream(st)
//	}
func (s *Session) Accept() (*Stream, error) {
	if s == nil || s.raw == nil {
		return nil, ErrSessionClosed
	}
	raw, err := s.raw.AcceptStream()
	if err != nil {
		if errors.Is(err, yamux.ErrSessionShutdown) || errors.Is(err, io.EOF) {
			return nil, ErrSessionClosed
		}
		return nil, fmt.Errorf("accept stream: %w", err)
	}
	return acceptStream(raw)
}

// CloseChan returns a channel that fires when the underlying yamux
// session has shut down (keepalive timeout, peer Close, network
// drop, explicit Close). Worker reconnect loop / server cluster
// unregister listen for this.
func (s *Session) CloseChan() <-chan struct{} {
	if s == nil || s.raw == nil {
		closed := make(chan struct{})
		close(closed)
		return closed
	}
	return s.raw.CloseChan()
}

// Close terminates the session and all open streams immediately.
// Idempotent.
func (s *Session) Close() error {
	if s == nil || s.raw == nil {
		return nil
	}
	return s.raw.Close()
}

// NumStreams returns the current number of open yamux streams.
// Useful for metrics / debug snapshot endpoints.
func (s *Session) NumStreams() int {
	if s == nil || s.raw == nil {
		return 0
	}
	return s.raw.NumStreams()
}

// IsClosed reports whether the session has terminated.
func (s *Session) IsClosed() bool {
	if s == nil || s.raw == nil {
		return true
	}
	return s.raw.IsClosed()
}
