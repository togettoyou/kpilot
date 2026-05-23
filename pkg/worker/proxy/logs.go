package proxy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"sync/atomic"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"

	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	transportv2 "github.com/togettoyou/kpilot/pkg/transport/yamux"
)

const (
	// logsChunkSize bounds a single read+forward; smaller chunks
	// → snappier UI but more wire frames. 4 KiB is a good middle.
	logsChunkSize = 4096
	// maxLogBytes caps cumulative bytes streamed per log session.
	// A chatty pod tailed indefinitely could otherwise stream
	// gigabytes; 64 MiB ≈ 5 minutes at 200 KB/s.
	maxLogBytes int64 = 64 * 1024 * 1024
)

// LogsManager owns the lifecycle of all in-flight Pod log
// streaming sessions for this Worker. Phase C removed the per-
// session cancel map (yamux stream.Close cascades): we just
// read the LogsStartRequest, stream chunks to the yamux Writer
// directly, exit on read error / cap / FIN.
type LogsManager struct {
	clientset kubernetes.Interface
	inflight  atomic.Int32
}

func NewLogsManager(clientset kubernetes.Interface) *LogsManager {
	return &LogsManager{clientset: clientset}
}

// Inflight reports the number of currently-active pod log streams.
// Lock-free; safe for any goroutine.
func (m *LogsManager) Inflight() int32 { return m.inflight.Load() }

// HandleStream is the tunnel-dispatcher entry for an inbound
// STREAM_POD_LOGS. Reads the start request, opens a K8s log
// stream, forwards chunks as pbv2.LogsChunk frames, terminates
// with a sentinel (zero-byte LogsChunk) + pbv2.LogsEnd, closes.
//
// Sentinel discriminator contract (see gateway/stream.go): a
// real LogsChunk always has Data non-empty; the worker MUST
// send a zero-byte chunk before LogsEnd so the server side can
// switch frame types on its read loop.
//
// Cancellation: a watcher goroutine blocks on Read after the
// start frame. Server side leaves its write half open (see
// OpenLogsStream's doc); when the consumer calls stream.Close,
// the watcher's Read returns and we cancel the K8s log stream's
// ctx so the read loop unwinds.
func (m *LogsManager) HandleStream(ctx context.Context, st *transportv2.Stream) {
	m.inflight.Add(1)
	defer m.inflight.Add(-1)
	defer st.Close()
	var req pbv2.LogsStartRequest
	if err := st.ReadMsg(&req); err != nil {
		log.Printf("[wire] logs read req failed: request=%s err=%v", st.RequestID(), err)
		return
	}

	logCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		buf := make([]byte, 1)
		_, _ = st.Reader().Read(buf)
		cancel()
	}()

	opts := &corev1.PodLogOptions{
		Container: req.GetContainer(),
		Follow:    req.GetFollow(),
		Previous:  req.GetPrevious(),
	}
	if t := req.GetTailLines(); t > 0 {
		opts.TailLines = &t
	}
	if s := req.GetSinceSeconds(); s > 0 {
		opts.SinceSeconds = &s
	}

	stream, err := m.clientset.CoreV1().Pods(req.GetNamespace()).
		GetLogs(req.GetPod(), opts).Stream(logCtx)
	if err != nil {
		writeLogsEnd(st, err.Error())
		return
	}
	defer stream.Close()

	buf := make([]byte, logsChunkSize)
	var sent int64
	for {
		n, readErr := stream.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			if werr := st.WriteMsg(&pbv2.LogsChunk{Data: chunk}); werr != nil {
				log.Printf("[logs] send failed (likely cancel): request=%s err=%v",
					st.RequestID(), werr)
				return
			}
			sent += int64(n)
			if sent >= maxLogBytes {
				writeLogsEnd(st, fmt.Sprintf(
					"log stream exceeded %d-byte session cap; reopen to continue",
					maxLogBytes))
				return
			}
		}
		if readErr != nil {
			endErr := ""
			if !errors.Is(readErr, io.EOF) && !errors.Is(readErr, context.Canceled) {
				endErr = readErr.Error()
			}
			writeLogsEnd(st, endErr)
			return
		}
	}
}

// writeLogsEnd sends the sentinel zero-byte LogsChunk + the
// final LogsEnd frame.
func writeLogsEnd(st *transportv2.Stream, errMsg string) {
	if err := st.WriteMsg(&pbv2.LogsChunk{}); err != nil {
		return
	}
	_ = st.WriteMsg(&pbv2.LogsEnd{Error: errMsg})
}
