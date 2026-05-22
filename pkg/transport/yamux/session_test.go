package transport

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	pb "github.com/togettoyou/kpilot/pkg/common/proto/v2"
)

// sessionPair returns a (client, server) Session pair connected
// via an in-memory net.Pipe. Skips TLS — the transport package's
// session layer is auth/encryption-agnostic; phase B/C wires
// tls.Conn into the same net.Conn slot.
func sessionPair(t *testing.T) (*Session, *Session) {
	t.Helper()
	// yamux requires a real net.Conn (not a one-shot Pipe pair —
	// it needs Read/Write deadlines), so use net.Pipe which gives
	// us a synchronous in-memory pair with the full net.Conn API.
	a, b := net.Pipe()
	t.Cleanup(func() {
		_ = a.Close()
		_ = b.Close()
	})

	// yamux Client/Server bootstrap is synchronous on a working
	// conn; both calls return promptly without exchanging any
	// frames beyond the initial handshake.
	type result struct {
		s   *Session
		err error
	}
	cliCh := make(chan result, 1)
	srvCh := make(chan result, 1)
	go func() {
		s, err := NewClientSession(a, nil)
		cliCh <- result{s, err}
	}()
	go func() {
		s, err := NewServerSession(b, nil)
		srvCh <- result{s, err}
	}()
	cli := <-cliCh
	srv := <-srvCh
	if cli.err != nil {
		t.Fatalf("client session: %v", cli.err)
	}
	if srv.err != nil {
		t.Fatalf("server session: %v", srv.err)
	}
	t.Cleanup(func() {
		_ = cli.s.Close()
		_ = srv.s.Close()
	})
	return cli.s, srv.s
}

func TestSessionOpenAccept(t *testing.T) {
	cli, srv := sessionPair(t)

	// Server-side accept loop.
	gotKind := make(chan pb.StreamKind, 1)
	gotID := make(chan string, 1)
	go func() {
		st, err := srv.Accept()
		if err != nil {
			t.Errorf("Accept: %v", err)
			return
		}
		gotKind <- st.Kind()
		gotID <- st.RequestID()
		_ = st.Close()
	}()

	// Client opens a stream.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	st, err := cli.Open(ctx, pb.StreamKind_STREAM_HTTP_REQUEST, "req-1", false)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer st.Close()

	select {
	case k := <-gotKind:
		if k != pb.StreamKind_STREAM_HTTP_REQUEST {
			t.Errorf("server got kind = %v, want STREAM_HTTP_REQUEST", k)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for server accept")
	}
	if id := <-gotID; id != "req-1" {
		t.Errorf("server got request_id = %q, want req-1", id)
	}
}

func TestSessionCloseChan(t *testing.T) {
	cli, srv := sessionPair(t)

	// Client closes; server's CloseChan should fire shortly.
	if err := cli.Close(); err != nil {
		t.Fatalf("client Close: %v", err)
	}
	select {
	case <-srv.CloseChan():
	case <-time.After(2 * time.Second):
		t.Fatal("server CloseChan didn't fire after client close")
	}
	if !srv.IsClosed() {
		t.Error("server IsClosed = false after CloseChan fired")
	}
}

func TestStreamCloseCancelsPeer(t *testing.T) {
	// Verify v2 cancellation semantics: client opens a stream,
	// then Close → server's pending Read should return promptly
	// (replaces v1's HttpCancel / LogsCancel / ExecCancel frames).
	cli, srv := sessionPair(t)

	srvReady := make(chan struct{})
	srvErr := make(chan error, 1)
	go func() {
		st, err := srv.Accept()
		if err != nil {
			srvErr <- err
			return
		}
		close(srvReady)
		// Server tries to read another message; client never sends one.
		var msg pb.ResourceRequest
		err = st.ReadMsg(&msg)
		srvErr <- err
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	st, err := cli.Open(ctx, pb.StreamKind_STREAM_RESOURCE_REQUEST, "req-x", false)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	<-srvReady

	// Cancel: just close.
	if err := st.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	select {
	case err := <-srvErr:
		// Want some error (EOF, closed, etc.) — the specific error
		// is yamux-defined and not worth pinning down here.
		if err == nil {
			t.Error("server ReadMsg returned nil after client Close, want error")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server Read didn't unblock after client Close")
	}
}

func TestStreamGzipNegotiated(t *testing.T) {
	cli, srv := sessionPair(t)

	srvDone := make(chan error, 1)
	go func() {
		st, err := srv.Accept()
		if err != nil {
			srvDone <- err
			return
		}
		defer st.Close()
		// Header should reflect gzip negotiation.
		if !st.Header().GetGzip() {
			srvDone <- errors.New("server header missing gzip flag")
			return
		}
		// Read a real proto and verify it round-trips through gzip.
		var req pb.RegisterRequest
		if err := st.ReadMsg(&req); err != nil {
			srvDone <- err
			return
		}
		if req.GetClusterToken() != "abc" {
			srvDone <- errors.New("token mismatch")
			return
		}
		srvDone <- nil
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	st, err := cli.Open(ctx, pb.StreamKind_STREAM_REGISTER, "", true /*gzip*/)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := st.WriteMsg(&pb.RegisterRequest{ClusterToken: "abc"}); err != nil {
		t.Fatalf("WriteMsg: %v", err)
	}
	// CloseWrite flushes the gzip block so the server's Read
	// doesn't sit waiting for more data.
	if err := st.CloseWrite(); err != nil {
		t.Fatalf("CloseWrite: %v", err)
	}

	select {
	case err := <-srvDone:
		if err != nil {
			t.Fatalf("server: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for server")
	}
	_ = st.Close()
}

// TestSessionAcceptAfterClose verifies Accept unblocks with
// ErrSessionClosed (not a hang) when the session shuts down.
func TestSessionAcceptAfterClose(t *testing.T) {
	cli, srv := sessionPair(t)

	acceptDone := make(chan error, 1)
	go func() {
		_, err := srv.Accept()
		acceptDone <- err
	}()
	// Give the goroutine time to block on Accept.
	time.Sleep(50 * time.Millisecond)
	_ = cli.Close()

	select {
	case err := <-acceptDone:
		if err == nil {
			t.Error("Accept returned nil after session close")
		}
		// We expect ErrSessionClosed or a yamux/io error — both
		// are acceptable as "session is gone".
		if !errors.Is(err, ErrSessionClosed) && !errors.Is(err, io.EOF) {
			t.Logf("Accept returned %v (acceptable as session-closed signal)", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Accept didn't unblock after session close")
	}
}

func TestSessionConcurrentOpens(t *testing.T) {
	// 20 client-side Open calls in parallel against a single
	// server-side serial Accept loop. Verifies streams stay
	// independent + RequestIDs aren't crossed when yamux's
	// AcceptStream dispatch is multiplexing many SYN_STREAM
	// frames behind the scenes.
	cli, srv := sessionPair(t)

	const n = 20
	var srvWG sync.WaitGroup
	srvWG.Add(n)
	got := make(chan string, n)
	go func() {
		for i := 0; i < n; i++ {
			st, err := srv.Accept()
			if err != nil {
				t.Errorf("Accept #%d: %v", i, err)
				srvWG.Done()
				continue
			}
			go func(s *Stream) {
				defer srvWG.Done()
				defer s.Close()
				got <- s.RequestID()
			}(st)
		}
	}()

	var cliWG sync.WaitGroup
	cliWG.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer cliWG.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			id := "req-" + intStr(i)
			st, err := cli.Open(ctx, pb.StreamKind_STREAM_HTTP_REQUEST, id, false)
			if err != nil {
				t.Errorf("Open #%d: %v", i, err)
				return
			}
			_ = st.Close()
		}(i)
	}
	cliWG.Wait()
	srvWG.Wait()
	close(got)

	seen := make(map[string]bool, n)
	for id := range got {
		seen[id] = true
	}
	if len(seen) != n {
		t.Errorf("got %d distinct request_ids, want %d", len(seen), n)
	}
}

// intStr converts a small int to its decimal string without
// importing strconv — keeps test deps minimal.
func intStr(i int) string {
	if i == 0 {
		return "0"
	}
	var buf [4]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(buf[pos:])
}
