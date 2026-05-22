package transport

import (
	"errors"
	"fmt"
	"io"

	"github.com/hashicorp/yamux"
	"google.golang.org/protobuf/proto"

	pb "github.com/togettoyou/kpilot/pkg/common/proto/v2"
)

// Stream is one logical RPC: a yamux stream plus a Codec that knows
// the framing + optional gzip on top of it. Created via Session.Open
// (caller side) or Session.accept (callee side); both wrap their
// respective yamux stream with the agreed-upon header.
//
// All Read/Write happens on the yamux stream — yamux handles
// per-stream flow control (default 4 MiB window, see config.go).
// Closing the stream RSTs the peer, which is how cancellation
// flows in v2 (replaces v1's HttpCancel / LogsCancel / ExecCancel
// frames).
type Stream struct {
	// raw is the underlying yamux stream. Exposed via Raw() for
	// callers that need stream-level ops (SetDeadline / CloseWrite /
	// Close); the codec methods cover the framing protocol layer.
	raw *yamux.Stream

	// cdc handles length-prefix framing + optional gzip wrap. The
	// underlying ReadWriter is `raw` (or the gzip wrappers of it).
	cdc *Codec

	// hdr is the StreamHeader the peers exchanged on open. Callers
	// dispatch on Kind to pick the right handler.
	hdr *pb.StreamHeader
}

// Header returns the StreamHeader that was exchanged on open. Use
// Header().Kind to dispatch, Header().RequestId for log correlation.
func (s *Stream) Header() *pb.StreamHeader {
	return s.hdr
}

// Kind is a shortcut for Header().Kind.
func (s *Stream) Kind() pb.StreamKind {
	if s.hdr == nil {
		return pb.StreamKind_STREAM_UNKNOWN
	}
	return s.hdr.GetKind()
}

// RequestID is a shortcut for Header().RequestId. Used for log
// correlation across server / worker. yamux assigns its own
// stream id for actual routing; this is for humans grepping logs.
func (s *Stream) RequestID() string {
	if s.hdr == nil {
		return ""
	}
	return s.hdr.GetRequestId()
}

// WriteMsg sends one length-prefix framed proto message.
// See Codec.WriteMsg for thread-safety + gzip-flush semantics.
func (s *Stream) WriteMsg(m proto.Message) error {
	return s.cdc.WriteMsg(m)
}

// ReadMsg reads one length-prefix framed proto message.
// Returns io.EOF when the peer half-closes its write side.
func (s *Stream) ReadMsg(m proto.Message) error {
	return s.cdc.ReadMsg(m)
}

// Reader exposes the raw byte stream for callers that want to
// transfer bytes directly after the framed *Start message —
// HTTP body, SSE chunks, pod log bytes, chart blob bytes. After
// switching to raw byte reads, no more ReadMsg calls should
// happen on this stream (the framing is lost).
func (s *Stream) Reader() io.Reader {
	return s.cdc.Reader()
}

// Writer exposes the raw byte sink. Same caveat as Reader.
func (s *Stream) Writer() io.Writer {
	return s.cdc.Writer()
}

// CloseWrite half-closes the write side. The peer's reader will
// observe io.EOF after draining what's already been sent. This is
// the "I'm done writing, you're free to reply" signal — used
// e.g. by the server after writing an HTTP request to tell the
// worker it can start replying.
//
// Flushes gzip writer first so the peer doesn't see a truncated
// gzip block.
func (s *Stream) CloseWrite() error {
	if err := s.cdc.Close(); err != nil {
		return fmt.Errorf("flush gzip: %w", err)
	}
	if cw, ok := any(s.raw).(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	// yamux.Stream implements CloseWrite as of yamux v0.1.x; the
	// type assertion above just defends against future API drift.
	return s.raw.Close()
}

// Close hard-closes the stream in both directions, sending an
// RST-equivalent to the peer. Used for cancellation: peer's
// Read / Write will return immediately with an error. Idempotent.
func (s *Stream) Close() error {
	// Best-effort gzip flush; ignore error since we're tearing down.
	_ = s.cdc.Close()
	return s.raw.Close()
}

// Raw returns the underlying yamux stream for callers that need
// stream-level ops not exposed here (SetDeadline, etc).
func (s *Stream) Raw() *yamux.Stream {
	return s.raw
}

// openStream is the producer side of stream initiation: wraps a
// freshly-opened yamux stream with a codec, writes the agreed
// StreamHeader (always plaintext), then optionally swaps the codec
// to gzip mode for subsequent messages.
//
// Both ends MUST follow the same gzip decision: caller sets hdr.Gzip,
// acceptStream reads it from the header and mirrors.
func openStream(raw *yamux.Stream, hdr *pb.StreamHeader) (*Stream, error) {
	cdc := NewCodec(raw)
	if err := cdc.WriteMsg(hdr); err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("write header: %w", err)
	}
	if hdr.GetGzip() {
		if err := cdc.EnableGzip(); err != nil {
			_ = raw.Close()
			return nil, fmt.Errorf("enable gzip: %w", err)
		}
	}
	return &Stream{raw: raw, cdc: cdc, hdr: hdr}, nil
}

// acceptStream is the consumer side: reads the header (plaintext),
// then optionally swaps the codec to gzip. Returns the populated
// Stream so the caller can switch on Kind() to dispatch.
func acceptStream(raw *yamux.Stream) (*Stream, error) {
	cdc := NewCodec(raw)
	var hdr pb.StreamHeader
	if err := cdc.ReadMsg(&hdr); err != nil {
		_ = raw.Close()
		if errors.Is(err, io.EOF) {
			return nil, io.EOF
		}
		return nil, fmt.Errorf("read header: %w", err)
	}
	if hdr.GetGzip() {
		if err := cdc.EnableGzip(); err != nil {
			_ = raw.Close()
			return nil, fmt.Errorf("enable gzip: %w", err)
		}
	}
	return &Stream{raw: raw, cdc: cdc, hdr: &hdr}, nil
}
