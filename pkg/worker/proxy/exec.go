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
	kexec "k8s.io/client-go/util/exec"
	"google.golang.org/protobuf/proto"

	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	transportv2 "github.com/togettoyou/kpilot/pkg/transport/yamux"
)

const shellProbeTimeout = 5 * time.Second

// ExecManager handles Pod exec sessions. Phase C dropped the
// per-session registry — each yamux stream owns its session
// lifetime, and yamux Read/Write deliver cancellation natively.
type ExecManager struct {
	cfg       *rest.Config
	clientset kubernetes.Interface
}

func NewExecManager(cfg *rest.Config, clientset kubernetes.Interface) *ExecManager {
	return &ExecManager{cfg: cfg, clientset: clientset}
}

// HandleStream is the tunnel entry for an inbound STREAM_POD_EXEC.
// Reads ExecStartRequest, sets up SPDY exec, spawns a goroutine to
// read further ExecStdin / ExecResize frames from the stream
// (concurrent with stdout/stderr Writes), and pumps stdout/stderr
// frames out. On exit emits the sentinel zero-byte ExecOutput +
// final ExecEnd, closes the stream.
//
// Cancellation: server stream.Close → our next Write fails AND
// our stdin reader's Read returns EOF → ctx cancels via defer
// → SPDY exec unwinds.
func (m *ExecManager) HandleStream(ctx context.Context, st *transportv2.Stream) {
	defer st.Close()

	var req pbv2.ExecStartRequest
	if err := st.ReadMsg(&req); err != nil {
		log.Printf("[wire] exec read req failed: request=%s err=%v", st.RequestID(), err)
		return
	}

	sessCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	stdinR, stdinW := io.Pipe()
	resizeCh := make(chan remotecommand.TerminalSize, 4)
	if req.GetCols() > 0 && req.GetRows() > 0 {
		resizeCh <- remotecommand.TerminalSize{
			Width:  uint16(req.GetCols()),
			Height: uint16(req.GetRows()),
		}
	}

	// Reader goroutine: pumps incoming Stdin / Resize messages
	// from the yamux stream into the SPDY exec.
	var readWG sync.WaitGroup
	readWG.Add(1)
	go func() {
		defer readWG.Done()
		defer stdinW.Close()
		// Close resizeCh under closeMu to avoid panicking the
		// SPDY exec's TerminalSizeQueue.Next; closeOnce guarantees
		// at most one close.
		defer func() {
			defer func() { _ = recover() }()
			close(resizeCh)
		}()
		for {
			// One stream carries two message types (ExecStdin
			// from keystrokes, ExecResize from terminal resize).
			// v2 dropped proto oneofs, so we read raw bytes
			// and try each Unmarshal. proto3 silently skips
			// unrecognized fields, so an ExecResize parsed as
			// ExecStdin yields ExecStdin{} (empty Data); an
			// ExecStdin parsed as ExecResize yields
			// ExecResize{} (zero Cols/Rows). Discriminator:
			// non-empty Data = stdin; non-zero Cols/Rows = resize.
			raw, err := st.ReadRaw()
			if err != nil {
				return
			}
			var stdin pbv2.ExecStdin
			_ = proto.Unmarshal(raw, &stdin)
			if len(stdin.GetData()) > 0 {
				if _, werr := stdinW.Write(stdin.GetData()); werr != nil {
					return
				}
				continue
			}
			var resize pbv2.ExecResize
			_ = proto.Unmarshal(raw, &resize)
			if resize.GetCols() > 0 && resize.GetRows() > 0 {
				select {
				case resizeCh <- remotecommand.TerminalSize{
					Width:  uint16(resize.GetCols()),
					Height: uint16(resize.GetRows()),
				}:
				default:
					// Drop — resize is idempotent, next event catches up.
				}
				continue
			}
			// Empty stdin AND empty resize — sentinel for "no more
			// input" or unknown payload. Treat as stdin EOF.
			return
		}
	}()

	cmd := req.GetCommand()
	if len(cmd) == 0 {
		cmd = []string{"/bin/bash"}
	}
	if len(cmd) == 1 && cmd[0] == "/bin/bash" {
		if !m.hasShell(req.GetNamespace(), req.GetPod(), req.GetContainer(), "/bin/bash") {
			cmd = []string{"/bin/sh"}
		}
	}

	r := m.clientset.CoreV1().RESTClient().Post().
		Resource("pods").
		Name(req.GetPod()).
		Namespace(req.GetNamespace()).
		SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: req.GetContainer(),
			Command:   cmd,
			Stdin:     true,
			Stdout:    true,
			Stderr:    true,
			TTY:       req.GetTty(),
		}, scheme.ParameterCodec)

	executor, err := remotecommand.NewSPDYExecutor(m.cfg, "POST", r.URL())
	if err != nil {
		writeExecEnd(st, 0, fmt.Sprintf("build executor: %v", err))
		return
	}

	stdoutW := &execWriter{stream: 1, st: st, onSendErr: cancel}
	stderrW := &execWriter{stream: 2, st: st, onSendErr: cancel}

	streamErr := executor.StreamWithContext(sessCtx, remotecommand.StreamOptions{
		Stdin:             stdinR,
		Stdout:            stdoutW,
		Stderr:            stderrW,
		Tty:               req.GetTty(),
		TerminalSizeQueue: &sizeQueue{ch: resizeCh},
	})

	// SPDY exec unwound — cancel ctx so stdin reader goroutine
	// exits. Then write the end sentinel + ExecEnd.
	cancel()
	_ = stdinR.Close()
	readWG.Wait()

	var exitCode int32
	endErr := ""
	if streamErr != nil && !errors.Is(streamErr, context.Canceled) {
		var ce kexec.CodeExitError
		if errors.As(streamErr, &ce) {
			exitCode = int32(ce.Code)
		}
		endErr = streamErr.Error()
	}
	writeExecEnd(st, exitCode, endErr)
}

// writeExecEnd emits the zero-byte ExecOutput sentinel + the
// final ExecEnd frame. See gateway/stream.go for the
// discriminator contract.
func writeExecEnd(st *transportv2.Stream, exitCode int32, errMsg string) {
	if err := st.WriteMsg(&pbv2.ExecOutput{}); err != nil {
		return
	}
	_ = st.WriteMsg(&pbv2.ExecEnd{ExitCode: exitCode, Error: errMsg})
}

// hasShell probes whether the given shell is installed and
// executable in the target container. Used for bash → sh
// fallback.
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

// execWriter implements io.Writer by wrapping each chunk in an
// ExecOutput frame on the yamux stream. onSendErr fires when the
// write fails so the SPDY executor's ctx gets cancelled —
// otherwise it ignores write errors and keeps running the user's
// command pointlessly.
type execWriter struct {
	stream    uint32
	st        *transportv2.Stream
	onSendErr func()
}

func (w *execWriter) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	chunk := make([]byte, len(p))
	copy(chunk, p)
	if err := w.st.WriteMsg(&pbv2.ExecOutput{
		Stream: w.stream,
		Data:   chunk,
	}); err != nil {
		if w.onSendErr != nil {
			w.onSendErr()
		}
		return 0, err
	}
	return len(p), nil
}

// sizeQueue adapts a Go channel to
// remotecommand.TerminalSizeQueue.
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
