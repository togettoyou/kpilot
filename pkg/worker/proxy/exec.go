package proxy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"

	"github.com/togettoyou/kpilot/pkg/common/proto"
)

const shellProbeTimeout = 5 * time.Second

// ExecManager owns active Pod exec sessions for this Worker. Each session
// runs the executor on its own goroutine; ExecStdin / ExecResize / ExecCancel
// frames from the Server are routed via session_id to the right session
// (which in turn pushes into the stdin pipe / resize chan / cancels ctx).
type ExecManager struct {
	cfg       *rest.Config
	clientset kubernetes.Interface
	tunnel    streamSender

	mu       sync.Mutex
	sessions map[string]*execSession
}

type execSession struct {
	cancel   context.CancelFunc
	stdinW   *io.PipeWriter
	resizeCh chan remotecommand.TerminalSize
	closed   bool
	closeMu  sync.Mutex
}

func NewExecManager(cfg *rest.Config, clientset kubernetes.Interface, tunnel streamSender) *ExecManager {
	return &ExecManager{
		cfg:       cfg,
		clientset: clientset,
		tunnel:    tunnel,
		sessions:  make(map[string]*execSession),
	}
}

// Start runs in its own goroutine (the tunnel dispatcher invokes via go).
// Builds an SPDY executor for the target pod/container, bridges its stdio
// to the gRPC stream, and blocks until the remote command exits or the
// session is cancelled.
func (m *ExecManager) Start(sessionID string, req *proto.ExecStartRequest) {
	ctx, cancel := context.WithCancel(context.Background())

	stdinR, stdinW := io.Pipe()
	resizeCh := make(chan remotecommand.TerminalSize, 4)
	if req.Cols > 0 && req.Rows > 0 {
		// Seed the queue with the initial size so the remote shell renders
		// at the user's actual terminal dimensions from the first prompt.
		resizeCh <- remotecommand.TerminalSize{Width: uint16(req.Cols), Height: uint16(req.Rows)}
	}

	sess := &execSession{
		cancel:   cancel,
		stdinW:   stdinW,
		resizeCh: resizeCh,
	}
	m.mu.Lock()
	m.sessions[sessionID] = sess
	m.mu.Unlock()

	defer m.cleanup(sessionID, sess)

	cmd := req.Command
	if len(cmd) == 0 {
		cmd = []string{"/bin/bash"}
	}
	// If the user picked /bin/bash (default or explicit), probe the container
	// quickly first and fall back to /bin/sh if bash isn't installed. We probe
	// instead of letting the real exec fail and retrying because retrying
	// after the interactive session has already started would race with stdin
	// the user might be typing.
	if len(cmd) == 1 && cmd[0] == "/bin/bash" {
		if !m.hasShell(req.Namespace, req.Pod, req.Container, "/bin/bash") {
			log.Printf("[exec] /bin/bash not found, falling back to /bin/sh: session=%s", sessionID)
			cmd = []string{"/bin/sh"}
		}
	}

	// Build the SPDY executor URL via the typed client (same auth+TLS path
	// the rest of client-go uses).
	r := m.clientset.CoreV1().RESTClient().Post().
		Resource("pods").
		Name(req.Pod).
		Namespace(req.Namespace).
		SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: req.Container,
			Command:   cmd,
			Stdin:     true,
			Stdout:    true,
			Stderr:    true,
			TTY:       req.Tty,
		}, scheme.ParameterCodec)

	executor, err := remotecommand.NewSPDYExecutor(m.cfg, "POST", r.URL())
	if err != nil {
		_ = m.tunnel.SendStreamMessage(sessionID, &proto.ExecEnd{Error: fmt.Sprintf("build executor: %v", err)})
		return
	}

	stdoutW := &execWriter{sessionID: sessionID, stream: 1, tunnel: m.tunnel}
	stderrW := &execWriter{sessionID: sessionID, stream: 2, tunnel: m.tunnel}

	streamErr := executor.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdin:             stdinR,
		Stdout:            stdoutW,
		Stderr:            stderrW,
		Tty:               req.Tty,
		TerminalSizeQueue: &sizeQueue{ch: resizeCh},
	})

	end := &proto.ExecEnd{}
	if streamErr != nil && !errors.Is(streamErr, context.Canceled) {
		// remotecommand wraps non-zero exit as exec.CodeExitError, which we
		// don't unwrap here — the message contains the code and is good
		// enough for the UI. Future iteration could parse exit_code out.
		end.Error = streamErr.Error()
	}
	_ = m.tunnel.SendStreamMessage(sessionID, end)
}

// Stdin forwards a stdin chunk from the Server to the active session.
func (m *ExecManager) Stdin(sessionID string, data []byte) {
	m.mu.Lock()
	sess, ok := m.sessions[sessionID]
	m.mu.Unlock()
	if !ok {
		return
	}
	sess.closeMu.Lock()
	closed := sess.closed
	sess.closeMu.Unlock()
	if closed {
		return
	}
	if _, err := sess.stdinW.Write(data); err != nil {
		log.Printf("[exec] stdin write: session=%s err=%v", sessionID, err)
	}
}

// Resize forwards a terminal size change to the active session.
func (m *ExecManager) Resize(sessionID string, cols, rows uint32) {
	m.mu.Lock()
	sess, ok := m.sessions[sessionID]
	m.mu.Unlock()
	if !ok {
		return
	}
	// Hold closeMu to prevent racing with closeSession which closes resizeCh
	// — sending on a closed channel panics.
	sess.closeMu.Lock()
	defer sess.closeMu.Unlock()
	if sess.closed {
		return
	}
	select {
	case sess.resizeCh <- remotecommand.TerminalSize{Width: uint16(cols), Height: uint16(rows)}:
	default:
		// Resize chan full → drop. Resize is idempotent: the next event will
		// catch up to the actual current size.
	}
}

// Cancel ends an active session (Server's ExecCancel or WS disconnect).
func (m *ExecManager) Cancel(sessionID string) {
	m.mu.Lock()
	sess, ok := m.sessions[sessionID]
	m.mu.Unlock()
	if !ok {
		return
	}
	m.closeSession(sess)
}

func (m *ExecManager) cleanup(sessionID string, sess *execSession) {
	m.mu.Lock()
	delete(m.sessions, sessionID)
	m.mu.Unlock()
	m.closeSession(sess)
}

func (m *ExecManager) closeSession(sess *execSession) {
	sess.closeMu.Lock()
	if sess.closed {
		sess.closeMu.Unlock()
		return
	}
	sess.closed = true
	sess.closeMu.Unlock()
	sess.cancel()
	_ = sess.stdinW.Close()
	close(sess.resizeCh)
}

// hasShell probes whether the given shell is installed and executable in the
// target container by running it with `-c exit 0`. Times out after 5s. Used
// for bash → sh fallback before starting the real interactive session.
func (m *ExecManager) hasShell(namespace, pod, container, shell string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), shellProbeTimeout)
	defer cancel()

	r := m.clientset.CoreV1().RESTClient().Post().
		Resource("pods").
		Name(pod).
		Namespace(namespace).
		SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: container,
			Command:   []string{shell, "-c", "exit 0"},
			Stdout:    true,
			Stderr:    true,
		}, scheme.ParameterCodec)

	executor, err := remotecommand.NewSPDYExecutor(m.cfg, "POST", r.URL())
	if err != nil {
		return false
	}
	return executor.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdout: io.Discard,
		Stderr: io.Discard,
	}) == nil
}

// execWriter implements io.Writer by wrapping each chunk in an ExecOutput
// frame and pushing it through the tunnel.
type execWriter struct {
	sessionID string
	stream    uint32
	tunnel    streamSender
}

func (w *execWriter) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	chunk := make([]byte, len(p))
	copy(chunk, p)
	if err := w.tunnel.SendStreamMessage(w.sessionID, &proto.ExecOutput{
		Stream: w.stream,
		Data:   chunk,
	}); err != nil {
		return 0, err
	}
	return len(p), nil
}

// sizeQueue adapts a Go channel to remotecommand.TerminalSizeQueue.
// Next blocks until a size arrives or the channel is closed (returns nil).
type sizeQueue struct {
	ch chan remotecommand.TerminalSize
}

func (q *sizeQueue) Next() *remotecommand.TerminalSize {
	s, ok := <-q.ch
	if !ok {
		return nil
	}
	return &s
}
