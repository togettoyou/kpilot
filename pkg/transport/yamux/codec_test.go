package transport

import (
	"bytes"
	"errors"
	"io"
	"net"
	"sync"
	"testing"

	pb "github.com/togettoyou/kpilot/pkg/common/proto/v2"
)

// codecPair returns two Codec instances connected via an in-memory
// net.Pipe — the simplest way to exercise the codec end-to-end
// without spinning up yamux.
func codecPair(t *testing.T) (*Codec, *Codec, func()) {
	t.Helper()
	a, b := net.Pipe()
	t.Cleanup(func() {
		_ = a.Close()
		_ = b.Close()
	})
	ca := NewCodec(a)
	cb := NewCodec(b)
	return ca, cb, func() { _ = a.Close(); _ = b.Close() }
}

func TestCodecRoundtrip(t *testing.T) {
	ca, cb, _ := codecPair(t)

	// One goroutine writes, the other reads. net.Pipe is synchronous
	// so a single direction is enough to exercise framing.
	writeErr := make(chan error, 1)
	go func() {
		writeErr <- ca.WriteMsg(&pb.StreamHeader{
			Kind:      pb.StreamKind_STREAM_HTTP_REQUEST,
			RequestId: "req-42",
		})
	}()

	var got pb.StreamHeader
	if err := cb.ReadMsg(&got); err != nil {
		t.Fatalf("ReadMsg: %v", err)
	}
	if err := <-writeErr; err != nil {
		t.Fatalf("WriteMsg: %v", err)
	}

	if got.GetKind() != pb.StreamKind_STREAM_HTTP_REQUEST {
		t.Errorf("kind = %v, want STREAM_HTTP_REQUEST", got.GetKind())
	}
	if got.GetRequestId() != "req-42" {
		t.Errorf("request_id = %q, want %q", got.GetRequestId(), "req-42")
	}
}

// Codec-level gzip can't be tested over net.Pipe because Pipe is
// synchronous (Write blocks until peer Reads) and EnableGzip on
// both sides simultaneously deadlocks each other's Flush. Real
// transport (yamux over any buffered conn) avoids this — see
// TestStreamGzipNegotiated in session_test.go for the end-to-end
// gzip-through-stream coverage.

func TestCodecRawBytesAfterFramed(t *testing.T) {
	// Common pattern: one framed *Start message, then raw bytes
	// (HTTP body / chart blob / log bytes). The framing layer
	// must not corrupt subsequent raw bytes.
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	ca := NewCodec(a)
	cb := NewCodec(b)

	body := bytes.Repeat([]byte{0xab, 0xcd, 0xef}, 4000) // 12 KiB binary

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := ca.WriteMsg(&pb.HTTPRequestStart{
			Method:   "POST",
			Url:      "http://test.svc:8000/v1/chat/completions",
			BodySize: int64(len(body)),
		}); err != nil {
			t.Errorf("WriteMsg start: %v", err)
			return
		}
		if _, err := ca.Writer().Write(body); err != nil {
			t.Errorf("Write body: %v", err)
			return
		}
		_ = a.Close() // signal EOF
	}()

	var start pb.HTTPRequestStart
	if err := cb.ReadMsg(&start); err != nil {
		t.Fatalf("ReadMsg start: %v", err)
	}
	if start.GetBodySize() != int64(len(body)) {
		t.Errorf("body_size = %d, want %d", start.GetBodySize(), len(body))
	}
	got, err := io.ReadAll(cb.Reader())
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("ReadAll body: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Errorf("body mismatch (got %d bytes, want %d)", len(got), len(body))
	}
	wg.Wait()
}

func TestCodecMessageTooLarge(t *testing.T) {
	a, _ := net.Pipe()
	defer a.Close()
	ca := NewCodec(a)
	// Marshal a real proto with a payload that exceeds maxMessageSize.
	huge := bytes.Repeat([]byte("x"), maxMessageSize+1)
	err := ca.WriteMsg(&pb.RegisterRequest{ClusterToken: string(huge)})
	if err == nil {
		t.Fatal("expected error for oversized message, got nil")
	}
}
