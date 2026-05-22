// Package gateway — typed streaming APIs (Pod logs, Pod exec, WS
// proxy) on top of yamux.
//
// In v1, one OpenStream returned a generic Stream whose Send /
// Recv took a proto.WorkerMessage oneof — the kind was implicit
// in the first Send. v2's StreamHeader makes the kind explicit
// at open time, so this file exposes three typed openers:
//
//   OpenLogsStream(clusterID) → LogsStream  (read-only chunks)
//   OpenExecStream(clusterID) → ExecStream  (bidirectional)
//   OpenWSStream(clusterID)   → WSStream    (bidirectional)
//
// Each wrapper holds the underlying yamux Stream and exposes
// typed Send / Recv methods. Close releases the stream
// (cancellation propagates as yamux FIN — replaces v1's custom
// LogsCancel / ExecCancel frames).
//
// Recv discriminates between the two message types each stream
// can carry (e.g. LogsChunk vs LogsEnd) via a zero-payload
// sentinel: worker sends a zero-byte LogsChunk to signal "next
// frame is LogsEnd". v2 dropped proto oneofs so this is the
// minimal-wire way to multiplex two message types on one
// stream without bringing the oneof envelope back.
package gateway

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/google/uuid"

	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	transportv2 "github.com/togettoyou/kpilot/pkg/transport/yamux"
)

// ─── Pod logs ──────────────────────────────────────────────────

// LogsStream is the server-side view of one in-flight Pod logs
// session. Server writes a single LogsStartRequest; worker
// streams LogsChunk messages until it half-closes (clean EOF)
// or sends a LogsEnd with an error.
type LogsStream struct {
	stream    *transportv2.Stream
	closeOnce sync.Once
}

// OpenLogsStream opens a STREAM_POD_LOGS stream + writes the
// start request. Returns a LogsStream ready for Recv calls.
// Caller MUST defer Close so the worker's kubectl-logs reader
// tears down when the consumer goes away.
func (g *GatewayServer) OpenLogsStream(ctx context.Context, clusterID string, start *pbv2.LogsStartRequest) (*LogsStream, error) {
	w, ok := g.GetWorker(clusterID)
	if !ok {
		return nil, fmt.Errorf("cluster %s not connected", clusterID)
	}
	st, err := w.Session.Open(ctx, pbv2.StreamKind_STREAM_POD_LOGS, uuid.NewString(), false /*gzip — log bytes mixed*/)
	if err != nil {
		return nil, fmt.Errorf("open logs stream: %w", err)
	}
	if err := st.WriteMsg(start); err != nil {
		_ = st.Close()
		return nil, fmt.Errorf("write logs start: %w", err)
	}
	if err := st.CloseWrite(); err != nil {
		_ = st.Close()
		return nil, fmt.Errorf("half-close logs req: %w", err)
	}
	return &LogsStream{stream: st}, nil
}

// Recv blocks until the next message arrives. Discriminator:
// LogsChunk.Data non-empty = chunk; zero-byte LogsChunk + next
// LogsEnd = end (worker contract). io.EOF = stream FIN without
// an explicit LogsEnd.
func (s *LogsStream) Recv() (*pbv2.LogsChunk, *pbv2.LogsEnd, error) {
	var chunk pbv2.LogsChunk
	if err := s.stream.ReadMsg(&chunk); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, nil, io.EOF
		}
		return nil, nil, err
	}
	if len(chunk.GetData()) > 0 {
		return &chunk, nil, nil
	}
	var end pbv2.LogsEnd
	if err := s.stream.ReadMsg(&end); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, nil, io.EOF
		}
		return nil, nil, err
	}
	return nil, &end, nil
}

// Close sends FIN. Idempotent.
func (s *LogsStream) Close() {
	s.closeOnce.Do(func() { _ = s.stream.Close() })
}

// ─── Pod exec ──────────────────────────────────────────────────

// ExecStream is the server-side view of one Pod exec session.
// Bidirectional: server writes ExecStdin / ExecResize on user
// input; worker writes ExecOutput frames; one ExecEnd carries
// exit code + close reason.
type ExecStream struct {
	stream    *transportv2.Stream
	closeOnce sync.Once
}

// OpenExecStream opens a STREAM_POD_EXEC stream + writes the
// start request. Caller MUST defer Close.
func (g *GatewayServer) OpenExecStream(ctx context.Context, clusterID string, start *pbv2.ExecStartRequest) (*ExecStream, error) {
	w, ok := g.GetWorker(clusterID)
	if !ok {
		return nil, fmt.Errorf("cluster %s not connected", clusterID)
	}
	st, err := w.Session.Open(ctx, pbv2.StreamKind_STREAM_POD_EXEC, uuid.NewString(), false /*gzip off — interactive*/)
	if err != nil {
		return nil, fmt.Errorf("open exec stream: %w", err)
	}
	if err := st.WriteMsg(start); err != nil {
		_ = st.Close()
		return nil, fmt.Errorf("write exec start: %w", err)
	}
	return &ExecStream{stream: st}, nil
}

// SendStdin forwards user keystrokes. Safe to call from a
// separate goroutine concurrently with Recv (yamux gives each
// stream a single sender goroutine internally, and our Codec
// serialises WriteMsg via writeMu).
func (s *ExecStream) SendStdin(data []byte) error {
	return s.stream.WriteMsg(&pbv2.ExecStdin{Data: data})
}

// SendResize updates the terminal size on a tty session.
func (s *ExecStream) SendResize(cols, rows uint32) error {
	return s.stream.WriteMsg(&pbv2.ExecResize{Cols: cols, Rows: rows})
}

// Recv blocks for the next ExecOutput or ExecEnd. Discriminator:
// ExecOutput.Stream non-zero OR Data non-empty = output frame;
// fully-zero ExecOutput + next ExecEnd = end (worker contract).
func (s *ExecStream) Recv() (*pbv2.ExecOutput, *pbv2.ExecEnd, error) {
	var out pbv2.ExecOutput
	if err := s.stream.ReadMsg(&out); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, nil, io.EOF
		}
		return nil, nil, err
	}
	if len(out.GetData()) > 0 || out.GetStream() != 0 {
		return &out, nil, nil
	}
	var end pbv2.ExecEnd
	if err := s.stream.ReadMsg(&end); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, nil, io.EOF
		}
		return nil, nil, err
	}
	return nil, &end, nil
}

// Close sends FIN — worker's kubectl-exec stream tears down,
// the container process gets SIGHUP via the SPDY proxy.
func (s *ExecStream) Close() {
	s.closeOnce.Do(func() { _ = s.stream.Close() })
}

// ─── WebSocket reverse proxy ───────────────────────────────────

// WSStream is the server-side view of one WS reverse proxy
// session. Bidirectional WSFrame relays; either side can close
// the stream with a WSEnd.
type WSStream struct {
	stream    *transportv2.Stream
	closeOnce sync.Once
}

// OpenWSStream opens a STREAM_WS_PROXY stream + writes the
// start request. Caller MUST defer Close.
func (g *GatewayServer) OpenWSStream(ctx context.Context, clusterID string, start *pbv2.WSStartRequest) (*WSStream, error) {
	w, ok := g.GetWorker(clusterID)
	if !ok {
		return nil, fmt.Errorf("cluster %s not connected", clusterID)
	}
	st, err := w.Session.Open(ctx, pbv2.StreamKind_STREAM_WS_PROXY, uuid.NewString(), false /*gzip off*/)
	if err != nil {
		return nil, fmt.Errorf("open ws stream: %w", err)
	}
	if err := st.WriteMsg(start); err != nil {
		_ = st.Close()
		return nil, fmt.Errorf("write ws start: %w", err)
	}
	return &WSStream{stream: st}, nil
}

// SendFrame relays one frame from the browser to the worker.
func (s *WSStream) SendFrame(opcode int32, data []byte) error {
	return s.stream.WriteMsg(&pbv2.WSFrame{Opcode: opcode, Data: data})
}

// SendEnd writes a WSEnd terminator. Use to relay a clean
// browser-side close to the upstream.
func (s *WSStream) SendEnd(code int32, reason string) error {
	return s.stream.WriteMsg(&pbv2.WSEnd{Code: code, Reason: reason})
}

// Recv blocks for the next WSFrame or WSEnd. Discriminator:
// non-zero opcode or non-empty data = frame; zero of both = end
// follows (worker contract).
func (s *WSStream) Recv() (*pbv2.WSFrame, *pbv2.WSEnd, error) {
	var f pbv2.WSFrame
	if err := s.stream.ReadMsg(&f); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, nil, io.EOF
		}
		return nil, nil, err
	}
	if f.GetOpcode() != 0 || len(f.GetData()) > 0 {
		return &f, nil, nil
	}
	var end pbv2.WSEnd
	if err := s.stream.ReadMsg(&end); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, nil, io.EOF
		}
		return nil, nil, err
	}
	return nil, &end, nil
}

// Close sends FIN.
func (s *WSStream) Close() {
	s.closeOnce.Do(func() { _ = s.stream.Close() })
}
