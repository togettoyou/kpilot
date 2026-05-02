package proxy

import (
	"context"
	"errors"
	"io"
	"log"
	"sync"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/togettoyou/kpilot/pkg/common/proto"
)

// logsChunkSize bounds a single read+forward; smaller chunks → snappier UI
// but more gRPC frames. 4KiB is a reasonable middle ground for tailing.
const logsChunkSize = 4096

// streamSender is satisfied by *tunnel.Client (avoids package import cycle).
type streamSender interface {
	SendStreamMessage(sessionID string, payload any) error
}

// LogsManager owns the lifecycle of all in-flight Pod log streaming sessions
// for this Worker. Sessions are keyed by session_id; cancellation is via the
// stored context.CancelFunc which causes the underlying K8s log stream to
// return io.EOF.
type LogsManager struct {
	clientset kubernetes.Interface
	tunnel    streamSender

	mu       sync.Mutex
	sessions map[string]context.CancelFunc
}

func NewLogsManager(clientset kubernetes.Interface, tunnel streamSender) *LogsManager {
	return &LogsManager{
		clientset: clientset,
		tunnel:    tunnel,
		sessions:  make(map[string]context.CancelFunc),
	}
}

// Start runs in its own goroutine (the tunnel dispatcher invokes us via go).
// Streams logs from the K8s API and forwards chunks to the Server until the
// stream ends or the session is cancelled.
func (m *LogsManager) Start(sessionID string, req *proto.LogsStartRequest) {
	ctx, cancel := context.WithCancel(context.Background())
	m.mu.Lock()
	m.sessions[sessionID] = cancel
	m.mu.Unlock()
	defer m.cleanup(sessionID)

	opts := &corev1.PodLogOptions{
		Container: req.Container,
		Follow:    req.Follow,
		Previous:  req.Previous,
	}
	if req.TailLines > 0 {
		opts.TailLines = &req.TailLines
	}
	if req.SinceSeconds > 0 {
		opts.SinceSeconds = &req.SinceSeconds
	}

	stream, err := m.clientset.CoreV1().Pods(req.Namespace).GetLogs(req.Pod, opts).Stream(ctx)
	if err != nil {
		_ = m.tunnel.SendStreamMessage(sessionID, &proto.LogsEnd{Error: err.Error()})
		return
	}
	defer stream.Close()

	buf := make([]byte, logsChunkSize)
	for {
		n, readErr := stream.Read(buf)
		if n > 0 {
			// Copy because the underlying buffer is reused on next Read.
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			if sendErr := m.tunnel.SendStreamMessage(sessionID, &proto.LogsChunk{Data: chunk}); sendErr != nil {
				log.Printf("[logs] send failed, ending stream: session=%s err=%v", sessionID, sendErr)
				return
			}
		}
		if readErr != nil {
			endMsg := &proto.LogsEnd{}
			// io.EOF is normal end-of-stream; context.Canceled is graceful client cancel.
			if !errors.Is(readErr, io.EOF) && !errors.Is(readErr, context.Canceled) {
				endMsg.Error = readErr.Error()
			}
			_ = m.tunnel.SendStreamMessage(sessionID, endMsg)
			return
		}
	}
}

// Cancel stops an active session (called from the tunnel dispatcher when the
// Server sends LogsCancel). Safe to call for unknown sessions.
func (m *LogsManager) Cancel(sessionID string) {
	m.mu.Lock()
	cancel, ok := m.sessions[sessionID]
	delete(m.sessions, sessionID)
	m.mu.Unlock()
	if ok {
		cancel()
	}
}

func (m *LogsManager) cleanup(sessionID string) {
	m.mu.Lock()
	delete(m.sessions, sessionID)
	m.mu.Unlock()
}
