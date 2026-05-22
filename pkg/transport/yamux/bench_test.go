package transport

import (
	"context"
	"crypto/rand"
	"io"
	"net"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/togettoyou/kpilot/pkg/common/proto/v2"
)

// localPipeSession returns a (client, server) Session pair over a
// real loopback TCP socket. We use loopback (not net.Pipe) because:
//   - net.Pipe is synchronous; yamux works but timings are skewed
//     by the per-write rendezvous
//   - loopback exercises the real Linux/macOS socket buffer path
//     yamux runs on in production
//
// Caller MUST defer the returned closer. Skips the test if any
// step fails (port binding etc. — bench shouldn't fail the whole
// suite over a flaky CI).
func benchSessionPair(b *testing.B) (cli, srv *Session, closer func()) {
	b.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		b.Skipf("listen: %v", err)
	}

	type result struct {
		conn net.Conn
		err  error
	}
	srvCh := make(chan result, 1)
	go func() {
		c, err := lis.Accept()
		srvCh <- result{c, err}
	}()

	cliConn, err := net.Dial("tcp", lis.Addr().String())
	if err != nil {
		_ = lis.Close()
		b.Skipf("dial: %v", err)
	}
	srvRes := <-srvCh
	_ = lis.Close()
	if srvRes.err != nil {
		_ = cliConn.Close()
		b.Skipf("accept: %v", srvRes.err)
	}

	cli, err = NewClientSession(cliConn, nil)
	if err != nil {
		b.Skipf("client session: %v", err)
	}
	srv, err = NewServerSession(srvRes.conn, nil)
	if err != nil {
		b.Skipf("server session: %v", err)
	}
	closer = func() {
		_ = cli.Close()
		_ = srv.Close()
		_ = cliConn.Close()
		_ = srvRes.conn.Close()
	}
	return
}

// BenchmarkCodecWriteMsgSmall — pure framing throughput for a small
// proto (StreamHeader). Measures Marshal + uvarint + Write to a
// no-op sink (bytes.Buffer-equivalent via discardWriter).
func BenchmarkCodecWriteMsgSmall(b *testing.B) {
	rw := &nopReadWriter{Writer: io.Discard}
	c := NewCodec(rw)
	hdr := &pb.StreamHeader{
		Kind:      pb.StreamKind_STREAM_HTTP_REQUEST,
		RequestId: "bench-request-id-here",
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := c.WriteMsg(hdr); err != nil {
			b.Fatal(err)
		}
	}
}

// nopReadWriter combines an arbitrary writer with a never-returning
// reader; used by write benchmarks that don't read anything back.
type nopReadWriter struct {
	io.Writer
}

func (nopReadWriter) Read(p []byte) (int, error) { return 0, io.EOF }

// BenchmarkSessionOpenAccept — end-to-end open + accept latency
// over real loopback TCP yamux. This is the floor for any RPC's
// startup cost in v2.
func BenchmarkSessionOpenAccept(b *testing.B) {
	cli, srv, closer := benchSessionPair(b)
	defer closer()

	// Server-side acceptor: drains streams and closes them.
	stop := make(chan struct{})
	go func() {
		for {
			st, err := srv.Accept()
			if err != nil {
				return
			}
			_ = st.Close()
		}
	}()
	defer close(stop)

	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		st, err := cli.Open(ctx, pb.StreamKind_STREAM_HTTP_REQUEST, "", false)
		if err != nil {
			b.Fatal(err)
		}
		_ = st.Close()
	}
}

// BenchmarkRPCRoundtrip — open + send 1 framed request + read 1
// framed response + close. Models the most common pattern (an
// HTTP buffered RPC, a resource list RPC, etc.).
func BenchmarkRPCRoundtrip(b *testing.B) {
	cli, srv, closer := benchSessionPair(b)
	defer closer()

	// Server: accept, read request, send response, close.
	go func() {
		for {
			st, err := srv.Accept()
			if err != nil {
				return
			}
			var req pb.HTTPRequestStart
			if err := st.ReadMsg(&req); err != nil {
				_ = st.Close()
				continue
			}
			_ = st.WriteMsg(&pb.HTTPResponseStart{Status: 200, BodySize: 0})
			_ = st.Close()
		}
	}()

	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		st, err := cli.Open(ctx, pb.StreamKind_STREAM_HTTP_REQUEST, "", false)
		if err != nil {
			b.Fatal(err)
		}
		if err := st.WriteMsg(&pb.HTTPRequestStart{
			Method: "GET",
			Url:    "http://upstream.svc.cluster.local:8080/ping",
		}); err != nil {
			b.Fatal(err)
		}
		var resp pb.HTTPResponseStart
		if err := st.ReadMsg(&resp); err != nil {
			b.Fatal(err)
		}
		_ = st.Close()
	}
}

// BenchmarkConcurrentSmallRPCs — N concurrent small RPCs in flight
// simultaneously. The headline metric is "do they keep their own
// latency floor, or does one head-of-line block the others?" — yamux
// per-stream windows should keep them independent.
func BenchmarkConcurrentSmallRPCs(b *testing.B) {
	cli, srv, closer := benchSessionPair(b)
	defer closer()

	// Server: accept loop dispatches per-stream handlers.
	go func() {
		for {
			st, err := srv.Accept()
			if err != nil {
				return
			}
			go func(s *Stream) {
				defer s.Close()
				var req pb.HTTPRequestStart
				if err := s.ReadMsg(&req); err != nil {
					return
				}
				_ = s.WriteMsg(&pb.HTTPResponseStart{Status: 200})
			}(st)
		}
	}()

	concurrency := 64
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb_ *testing.PB) {
		_ = concurrency
		ctx := context.Background()
		for pb_.Next() {
			st, err := cli.Open(ctx, pb.StreamKind_STREAM_HTTP_REQUEST, "", false)
			if err != nil {
				b.Fatal(err)
			}
			if err := st.WriteMsg(&pb.HTTPRequestStart{Method: "GET", Url: "/x"}); err != nil {
				b.Fatal(err)
			}
			var resp pb.HTTPResponseStart
			if err := st.ReadMsg(&resp); err != nil {
				b.Fatal(err)
			}
			_ = st.Close()
		}
	})
}

// BenchmarkHOLBigStreamVsSmallRPCs — the headline v1 vs v2 number
// from docs/transport-v2.md §10. Background: one 20 MiB stream
// transferring in chunks while N small RPCs fire concurrently.
// v1 prioritySender + per-request_id round-robin gave small RPCs
// ~50-200ms P99. v2 yamux per-stream window should give ~5-20ms.
//
// Reports the per-small-RPC latency (ns/op) so smaller = better.
func BenchmarkHOLBigStreamVsSmallRPCs(b *testing.B) {
	cli, srv, closer := benchSessionPair(b)
	defer closer()

	// Server: small RPCs + one streaming sink for the big payload.
	go func() {
		for {
			st, err := srv.Accept()
			if err != nil {
				return
			}
			go func(s *Stream) {
				defer s.Close()
				switch s.Kind() {
				case pb.StreamKind_STREAM_HTTP_REQUEST:
					var req pb.HTTPRequestStart
					if err := s.ReadMsg(&req); err != nil {
						return
					}
					// Drain raw body if any (the big-stream branch).
					if req.GetBodySize() > 0 {
						_, _ = io.Copy(io.Discard, io.LimitReader(s.Reader(), req.GetBodySize()))
					}
					_ = s.WriteMsg(&pb.HTTPResponseStart{Status: 200})
				default:
					_ = s.WriteMsg(&pb.HTTPResponseStart{Status: 200})
				}
			}(st)
		}
	}()

	// Background: one big stream in flight the whole bench.
	stopBig := make(chan struct{})
	bigDone := make(chan struct{})
	go func() {
		defer close(bigDone)
		ctx := context.Background()
		buf := make([]byte, 64*1024)
		_, _ = rand.Read(buf)
		for {
			select {
			case <-stopBig:
				return
			default:
			}
			st, err := cli.Open(ctx, pb.StreamKind_STREAM_HTTP_REQUEST, "big", false)
			if err != nil {
				return
			}
			const totalBytes = 20 * 1024 * 1024
			if err := st.WriteMsg(&pb.HTTPRequestStart{
				Method:   "POST",
				Url:      "/big",
				BodySize: totalBytes,
			}); err != nil {
				_ = st.Close()
				continue
			}
			for written := 0; written < totalBytes; written += len(buf) {
				select {
				case <-stopBig:
					_ = st.Close()
					return
				default:
				}
				if _, err := st.Writer().Write(buf); err != nil {
					_ = st.Close()
					return
				}
			}
			_ = st.CloseWrite()
			var resp pb.HTTPResponseStart
			_ = st.ReadMsg(&resp)
			_ = st.Close()
		}
	}()

	// Settle: let the big stream get rolling before measuring.
	time.Sleep(100 * time.Millisecond)

	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		st, err := cli.Open(ctx, pb.StreamKind_STREAM_HTTP_REQUEST, "", false)
		if err != nil {
			b.Fatal(err)
		}
		if err := st.WriteMsg(&pb.HTTPRequestStart{Method: "GET", Url: "/small"}); err != nil {
			b.Fatal(err)
		}
		var resp pb.HTTPResponseStart
		if err := st.ReadMsg(&resp); err != nil {
			b.Fatal(err)
		}
		_ = st.Close()
	}
	b.StopTimer()
	close(stopBig)
	<-bigDone
}

// BenchmarkRawByteThroughput — peak streaming throughput for raw
// body bytes (HTTP body / chart blob / log chunks). Measures how
// fast yamux + framing + 64 KiB chunks can move bytes through
// loopback. Plateau is bound by yamux flow control + loopback
// kernel speed.
func BenchmarkRawByteThroughput(b *testing.B) {
	cli, srv, closer := benchSessionPair(b)
	defer closer()

	// Server drains everything on a single stream until close.
	srvRx := int64(0)
	go func() {
		for {
			st, err := srv.Accept()
			if err != nil {
				return
			}
			go func(s *Stream) {
				defer s.Close()
				var req pb.HTTPRequestStart
				if err := s.ReadMsg(&req); err != nil {
					return
				}
				n, _ := io.Copy(io.Discard, s.Reader())
				atomic.AddInt64(&srvRx, n)
				_ = s.WriteMsg(&pb.HTTPResponseStart{Status: 200})
			}(st)
		}
	}()

	const chunk = 64 * 1024
	buf := make([]byte, chunk)
	_, _ = rand.Read(buf)

	ctx := context.Background()
	b.SetBytes(int64(chunk))
	b.ReportAllocs()
	b.ResetTimer()

	st, err := cli.Open(ctx, pb.StreamKind_STREAM_HTTP_REQUEST, "tput", false)
	if err != nil {
		b.Fatal(err)
	}
	if err := st.WriteMsg(&pb.HTTPRequestStart{
		Method:   "POST",
		Url:      "/tput",
		BodySize: -1, // unknown — server reads till EOF
	}); err != nil {
		b.Fatal(err)
	}
	for i := 0; i < b.N; i++ {
		if _, err := st.Writer().Write(buf); err != nil {
			b.Fatal(err)
		}
	}
	_ = st.CloseWrite()
	var resp pb.HTTPResponseStart
	_ = st.ReadMsg(&resp)
	_ = st.Close()
}

// BenchmarkGzipOverhead — measure the cost of writing a small
// framed message through gzip vs plain. Useful to verify the
// per-message Flush in WriteMsg doesn't blow up small-message
// latency.
func BenchmarkGzipOverhead(b *testing.B) {
	b.Run("plain", func(b *testing.B) {
		cli, srv, closer := benchSessionPair(b)
		defer closer()
		runGzipBench(b, cli, srv, false)
	})
	b.Run("gzip", func(b *testing.B) {
		cli, srv, closer := benchSessionPair(b)
		defer closer()
		runGzipBench(b, cli, srv, true)
	})
}

func runGzipBench(b *testing.B, cli, srv *Session, gzip bool) {
	b.Helper()
	// Server: accept, drain, ack, close.
	go func() {
		for {
			st, err := srv.Accept()
			if err != nil {
				return
			}
			go func(s *Stream) {
				defer s.Close()
				var req pb.HTTPRequestStart
				if err := s.ReadMsg(&req); err != nil {
					return
				}
				if req.GetBodySize() > 0 {
					_, _ = io.Copy(io.Discard, io.LimitReader(s.Reader(), req.GetBodySize()))
				}
				_ = s.WriteMsg(&pb.HTTPResponseStart{Status: 200})
			}(st)
		}
	}()

	// 4 KiB JSON-ish body that compresses well.
	body := make([]byte, 4*1024)
	for i := range body {
		body[i] = byte('a' + i%26)
	}
	ctx := context.Background()
	b.SetBytes(int64(len(body)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		st, err := cli.Open(ctx, pb.StreamKind_STREAM_HTTP_REQUEST, "", gzip)
		if err != nil {
			b.Fatal(err)
		}
		if err := st.WriteMsg(&pb.HTTPRequestStart{
			Method:   "POST",
			Url:      "/x",
			BodySize: int64(len(body)),
		}); err != nil {
			b.Fatal(err)
		}
		if _, err := st.Writer().Write(body); err != nil {
			b.Fatal(err)
		}
		_ = st.CloseWrite()
		var resp pb.HTTPResponseStart
		if err := st.ReadMsg(&resp); err != nil {
			b.Fatal(err)
		}
		_ = st.Close()
	}
}

// BenchmarkCancelLatency — measure how fast a stream Close
// propagates as a cancellation to the peer's blocked Read.
// Docs §10 expects ms-level (vs v1's ~5s with per-write deadline).
func BenchmarkCancelLatency(b *testing.B) {
	cli, srv, closer := benchSessionPair(b)
	defer closer()

	// Server: accept, block on ReadMsg until peer closes, record
	// the time it takes for Read to unblock.
	type peerSignal struct {
		readUnblocked time.Time
	}
	srvCh := make(chan peerSignal, 1024)
	go func() {
		for {
			st, err := srv.Accept()
			if err != nil {
				return
			}
			go func(s *Stream) {
				defer s.Close()
				var msg pb.HTTPRequestStart
				// First read consumes the request header.
				if err := s.ReadMsg(&msg); err != nil {
					return
				}
				// Block on a second read that never arrives — when
				// the peer Closes, this returns io.EOF.
				_ = s.ReadMsg(&msg)
				srvCh <- peerSignal{readUnblocked: time.Now()}
			}(st)
		}
	}()

	ctx := context.Background()
	var totalLatency time.Duration
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		st, err := cli.Open(ctx, pb.StreamKind_STREAM_HTTP_REQUEST, "cancel", false)
		if err != nil {
			b.Fatal(err)
		}
		if err := st.WriteMsg(&pb.HTTPRequestStart{Method: "GET"}); err != nil {
			b.Fatal(err)
		}
		// Small settle so the server-side ReadMsg parks on the
		// second (blocking) read before we cancel.
		time.Sleep(50 * time.Microsecond)
		closeAt := time.Now()
		_ = st.Close()
		select {
		case sig := <-srvCh:
			totalLatency += sig.readUnblocked.Sub(closeAt)
		case <-time.After(time.Second):
			b.Fatal("server read didn't unblock within 1s")
		}
	}
	b.ReportMetric(float64(totalLatency.Nanoseconds())/float64(b.N), "cancel-ns/op")
}

// BenchmarkSessionMemory500Streams — measure heap footprint of
// 500 concurrently open streams (model for "many in-flight RPCs"
// load). Reports the HeapInuse delta as bytes-per-stream.
//
// Not a precise number — GC + kernel socket buffers make this
// fuzzy — but the order-of-magnitude tells the story (v1 had
// ~32 chunks × 64 KiB per stream worst case ≈ 2 MiB per RPC).
func BenchmarkSessionMemory500Streams(b *testing.B) {
	const n = 500
	for i := 0; i < b.N; i++ {
		cli, srv, closer := benchSessionPair(b)
		streamGate := make(chan struct{})
		var srvWG sync.WaitGroup
		go func() {
			for {
				st, err := srv.Accept()
				if err != nil {
					return
				}
				srvWG.Add(1)
				go func(s *Stream) {
					defer srvWG.Done()
					defer s.Close()
					<-streamGate
				}(st)
			}
		}()

		// Baseline mem before opening any stream.
		runtime.GC()
		var before runtime.MemStats
		runtime.ReadMemStats(&before)

		ctx := context.Background()
		streams := make([]*Stream, n)
		for j := 0; j < n; j++ {
			st, err := cli.Open(ctx, pb.StreamKind_STREAM_HTTP_REQUEST, "", false)
			if err != nil {
				b.Fatal(err)
			}
			streams[j] = st
		}
		// Settle so the server-side accept goroutines have all
		// landed in <-streamGate (their stack frames count).
		time.Sleep(200 * time.Millisecond)

		runtime.GC()
		var after runtime.MemStats
		runtime.ReadMemStats(&after)
		deltaBytes := after.HeapInuse - before.HeapInuse
		b.ReportMetric(float64(deltaBytes)/float64(n), "bytes/stream")

		// Teardown.
		for _, st := range streams {
			_ = st.Close()
		}
		close(streamGate)
		srvWG.Wait()
		closer()
	}
}
