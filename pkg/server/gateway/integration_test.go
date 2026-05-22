package gateway

import (
	"context"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	transportv2 "github.com/togettoyou/kpilot/pkg/transport/yamux"
)

// Phase E integration tests — exercise the full v2 transport stack
// (gateway Send*/Open* → yamux session → worker dispatch → response
// path) end-to-end without the K8s store / cluster registration
// dependency. A fake worker runs in a goroutine, accepts inbound
// streams, mirrors the request back as a synthetic response so we
// can verify the protocol round-trip.
//
// What's NOT tested here (covered elsewhere or out of scope):
//   - acceptYamuxRegister DB lookup — needs sqlite fixture (phase E
//     follow-up)
//   - replayPendingPluginCommands DB driven path — same
//   - The proxy/http.go upstream dial path — that's a worker-side
//     concern; this file owns the gateway↔worker WIRE.

// fakeWorker spins up a transportv2 server-side session over an
// in-memory net pipe and runs the inbound-stream handler set the
// test provides. Returns a *ConnectedWorker the test can use as if
// it had registered via acceptYamuxRegister.
func fakeWorker(t *testing.T, gw *GatewayServer, handlers map[pbv2.StreamKind]func(*transportv2.Stream)) *ConnectedWorker {
	t.Helper()

	a, b := net.Pipe()
	t.Cleanup(func() {
		_ = a.Close()
		_ = b.Close()
	})

	// yamux.Server runs on the WORKER side of the pipe — that's
	// the side that ACCEPTS streams the gateway opens (gateway is
	// the yamux client per Worker-dials-Server topology, but in
	// this test the gateway-side opens streams to the fake worker,
	// so we flip the yamux client/server roles to match the data
	// direction). The transport doesn't care which side is client
	// vs server for stream open semantics — both can OpenStream
	// and AcceptStream — but yamux requires one of each on a
	// session.
	type result struct {
		sess *transportv2.Session
		err  error
	}
	gwCh := make(chan result, 1)
	workerCh := make(chan result, 1)
	go func() {
		s, err := transportv2.NewClientSession(a, nil)
		gwCh <- result{s, err}
	}()
	go func() {
		s, err := transportv2.NewServerSession(b, nil)
		workerCh <- result{s, err}
	}()
	gwSess := <-gwCh
	wSess := <-workerCh
	if gwSess.err != nil {
		t.Fatalf("gw session: %v", gwSess.err)
	}
	if wSess.err != nil {
		t.Fatalf("worker session: %v", wSess.err)
	}
	t.Cleanup(func() {
		_ = gwSess.sess.Close()
		_ = wSess.sess.Close()
	})

	// Register the worker into the gateway state directly (bypass
	// the DB lookup that acceptYamuxRegister does).
	w := &ConnectedWorker{
		ClusterID:     "test-cluster",
		ClusterDomain: "cluster.local",
		Session:       gwSess.sess,
		done:          make(chan struct{}),
	}
	gw.mu.Lock()
	gw.workers[w.ClusterID] = w
	gw.mu.Unlock()
	t.Cleanup(func() {
		gw.mu.Lock()
		delete(gw.workers, w.ClusterID)
		gw.mu.Unlock()
	})

	// Worker-side accept loop: dispatch to the handler the test
	// registered for each kind. Each handler owns its stream's
	// lifetime (defer Close inside).
	go func() {
		for {
			st, err := wSess.sess.Accept()
			if err != nil {
				return
			}
			h, ok := handlers[st.Kind()]
			if !ok {
				_ = st.Close()
				continue
			}
			go h(st)
		}
	}()

	return w
}

func TestIntegrationResourceRoundtrip(t *testing.T) {
	gw := NewGatewayServer()

	// Fake worker handler: read ResourceRequest + optional body,
	// echo back ResourceResponse with the body reversed.
	handler := func(st *transportv2.Stream) {
		defer st.Close()
		var req pbv2.ResourceRequest
		if err := st.ReadMsg(&req); err != nil {
			t.Errorf("worker read req: %v", err)
			return
		}
		var body []byte
		if n := req.GetBodySize(); n > 0 {
			body = make([]byte, n)
			if _, err := io.ReadFull(st.Reader(), body); err != nil {
				t.Errorf("worker read body: %v", err)
				return
			}
		}
		// Reverse the body so the test can verify the bytes
		// round-tripped properly.
		out := make([]byte, len(body))
		for i, b := range body {
			out[len(body)-1-i] = b
		}
		if err := st.WriteMsg(&pbv2.ResourceResponse{
			Success:  true,
			BodySize: int64(len(out)),
		}); err != nil {
			t.Errorf("worker write resp: %v", err)
			return
		}
		if len(out) > 0 {
			if _, err := st.Writer().Write(out); err != nil {
				t.Errorf("worker write body: %v", err)
			}
		}
	}

	fakeWorker(t, gw, map[pbv2.StreamKind]func(*transportv2.Stream){
		pbv2.StreamKind_STREAM_RESOURCE_REQUEST: handler,
	})

	body := []byte("hello yamux")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	resp, err := gw.SendResourceRequest(ctx, "test-cluster", &ResourceRequest{
		Action: "get",
		Group:  "",
		Kind:   "Pod",
		Body:   body,
	})
	if err != nil {
		t.Fatalf("SendResourceRequest: %v", err)
	}
	if !resp.Success {
		t.Errorf("Success = false, want true (err=%q)", resp.Error)
	}
	want := "xumay olleh"
	if string(resp.Data) != want {
		t.Errorf("Data = %q, want %q", resp.Data, want)
	}
}

func TestIntegrationHTTPBuffered(t *testing.T) {
	gw := NewGatewayServer()

	handler := func(st *transportv2.Stream) {
		defer st.Close()
		var req pbv2.HTTPRequestStart
		if err := st.ReadMsg(&req); err != nil {
			t.Errorf("worker read req: %v", err)
			return
		}
		// Drain body (the buffered path doesn't need it for this
		// echo test, but we still must consume the bytes or the
		// stream is stuck).
		if n := req.GetBodySize(); n > 0 {
			body := make([]byte, n)
			if _, err := io.ReadFull(st.Reader(), body); err != nil {
				return
			}
		}
		respBody := []byte("HTTP/1.1 200 OK\n\nhello from " + req.GetMethod())
		_ = st.WriteMsg(&pbv2.HTTPResponseStart{
			Status: 200,
			Headers: []*pbv2.HTTPHeader{
				{Name: "Content-Type", Value: "text/plain"},
			},
			BodySize: int64(len(respBody)),
		})
		_, _ = st.Writer().Write(respBody)
	}

	fakeWorker(t, gw, map[pbv2.StreamKind]func(*transportv2.Stream){
		pbv2.StreamKind_STREAM_HTTP_REQUEST: handler,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	resp, err := gw.SendHTTPRequest(ctx, "test-cluster", &HTTPRequest{
		Method: "GET",
		URL:    "http://upstream.svc.cluster.local:8080/ping",
	})
	if err != nil {
		t.Fatalf("SendHTTPRequest: %v", err)
	}
	if resp.Status != 200 {
		t.Errorf("Status = %d, want 200", resp.Status)
	}
	if !strings.Contains(string(resp.Body), "hello from GET") {
		t.Errorf("Body = %q, missing greeting", resp.Body)
	}
	if len(resp.Headers) == 0 || resp.Headers[0].GetName() != "Content-Type" {
		t.Errorf("Headers = %v, want Content-Type first", resp.Headers)
	}
}

func TestIntegrationHTTPStreaming(t *testing.T) {
	gw := NewGatewayServer()

	// Streaming worker: writes 3 chunks of body bytes live (with a
	// small sleep between to simulate per-token SSE) then closes.
	handler := func(st *transportv2.Stream) {
		defer st.Close()
		var req pbv2.HTTPRequestStart
		if err := st.ReadMsg(&req); err != nil {
			return
		}
		if !req.GetStreamResponse() {
			t.Errorf("worker got StreamResponse=false, want true")
			return
		}
		_ = st.WriteMsg(&pbv2.HTTPResponseStart{
			Status:   200,
			BodySize: -1,
		})
		w := st.Writer()
		for i, chunk := range []string{"first\n", "second\n", "third\n"} {
			_ = i
			if _, err := w.Write([]byte(chunk)); err != nil {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	}

	fakeWorker(t, gw, map[pbv2.StreamKind]func(*transportv2.Stream){
		pbv2.StreamKind_STREAM_HTTP_REQUEST: handler,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	stream, err := gw.SendHTTPRequestStream(ctx, "test-cluster", &HTTPRequest{
		Method: "POST",
		URL:    "http://stream.svc.cluster.local:8080/v1/chat/completions",
	})
	if err != nil {
		t.Fatalf("SendHTTPRequestStream: %v", err)
	}
	defer stream.Close()

	if stream.Status != 200 {
		t.Errorf("Status = %d, want 200", stream.Status)
	}
	got, err := io.ReadAll(stream.Body)
	if err != nil && err != io.EOF {
		t.Fatalf("read body: %v", err)
	}
	want := "first\nsecond\nthird\n"
	if string(got) != want {
		t.Errorf("Body = %q, want %q", got, want)
	}
}

func TestIntegrationStreamCancelPropagates(t *testing.T) {
	// Verify that HTTPStream.Close on the gateway side propagates
	// as yamux FIN to the worker so the worker's next Write fails
	// — replaces v1's explicit HttpCancel frame.
	gw := NewGatewayServer()

	workerSawCancel := make(chan struct{}, 1)
	handler := func(st *transportv2.Stream) {
		defer st.Close()
		var req pbv2.HTTPRequestStart
		if err := st.ReadMsg(&req); err != nil {
			return
		}
		_ = st.WriteMsg(&pbv2.HTTPResponseStart{
			Status:   200,
			BodySize: -1,
		})
		// Cancel-watcher goroutine — mirrors what the real
		// handleStreamingResp does. yamux Close from the peer is
		// FIN, NOT RST: the peer's writes keep succeeding silently
		// after our FIN. The only way for this side to learn the
		// cancel is to read — once the peer Closes, our Read
		// returns io.EOF. Server side leaves the write half open
		// (no CloseWrite in SendHTTPRequestStream) so this Read
		// only fires when cancel actually happens.
		cancelled := make(chan struct{})
		go func() {
			buf := make([]byte, 1)
			_, _ = st.Reader().Read(buf)
			close(cancelled)
		}()
		// Write padding until cancel watcher fires.
		buf := []byte("padding\n")
		w := st.Writer()
		for {
			select {
			case <-cancelled:
				select {
				case workerSawCancel <- struct{}{}:
				default:
				}
				return
			default:
			}
			if _, err := w.Write(buf); err != nil {
				return
			}
		}
	}

	fakeWorker(t, gw, map[pbv2.StreamKind]func(*transportv2.Stream){
		pbv2.StreamKind_STREAM_HTTP_REQUEST: handler,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	stream, err := gw.SendHTTPRequestStream(ctx, "test-cluster", &HTTPRequest{
		Method: "GET",
		URL:    "http://stream.svc.cluster.local:8080/sse",
	})
	if err != nil {
		t.Fatalf("SendHTTPRequestStream: %v", err)
	}

	// Read a few bytes to confirm the stream is live, then Close.
	buf := make([]byte, 16)
	if _, err := stream.Body.Read(buf); err != nil {
		t.Fatalf("read first chunk: %v", err)
	}
	stream.Close()

	// Worker should detect the cancel via a write error within a
	// reasonable window. yamux FIN should hit the worker within
	// the time it takes for the next write to fail.
	select {
	case <-workerSawCancel:
	case <-time.After(2 * time.Second):
		t.Fatal("worker didn't observe cancel via write error within 2 s")
	}
}

// TestIntegrationConcurrentRequests verifies per-RPC isolation —
// concurrent SendResourceRequest calls should not interfere with
// each other (no head-of-line blocking, no request-id confusion).
func TestIntegrationConcurrentRequests(t *testing.T) {
	gw := NewGatewayServer()

	handler := func(st *transportv2.Stream) {
		defer st.Close()
		var req pbv2.ResourceRequest
		if err := st.ReadMsg(&req); err != nil {
			return
		}
		// Echo the action back as the body. Tiny artificial delay
		// so concurrent requests have a chance to interleave on
		// the same session.
		time.Sleep(5 * time.Millisecond)
		body := []byte(req.GetAction())
		_ = st.WriteMsg(&pbv2.ResourceResponse{
			Success:  true,
			BodySize: int64(len(body)),
		})
		_, _ = st.Writer().Write(body)
	}

	fakeWorker(t, gw, map[pbv2.StreamKind]func(*transportv2.Stream){
		pbv2.StreamKind_STREAM_RESOURCE_REQUEST: handler,
	})

	const n = 50
	var wg sync.WaitGroup
	wg.Add(n)
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			action := "list-" + intToStr(i)
			resp, err := gw.SendResourceRequest(ctx, "test-cluster", &ResourceRequest{
				Action: action,
			})
			if err != nil {
				errs <- err
				return
			}
			if string(resp.Data) != action {
				errs <- &mismatchErr{want: action, got: string(resp.Data)}
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}

type mismatchErr struct{ want, got string }

func (e *mismatchErr) Error() string { return "got " + e.got + " want " + e.want }

func intToStr(i int) string {
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
