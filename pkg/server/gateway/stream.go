package gateway

import (
	"fmt"
	"sync"

	"github.com/google/uuid"

	"github.com/togettoyou/kpilot/pkg/common/proto"
)

// streamBufferSize is the number of inbound frames buffered per session before
// the gateway starts dropping (and logging). Sized for typical log bursts; exec
// should never get close to this since it's interactive.
const streamBufferSize = 256

// Stream is a server-initiated streaming session with a Worker, used for both
// Pod logs (Worker pushes chunks) and Exec (bidirectional). Caller pattern:
//
//	s, err := gw.OpenStream(clusterID)
//	defer s.Close()
//	s.Send(&proto.LogsStartRequest{...})
//	for msg := range s.Recv() { ... }
type Stream struct {
	sessionID string
	clusterID string
	gateway   *GatewayServer
	worker    *ConnectedWorker
	msgCh     chan *proto.WorkerMessage

	closeMu sync.Mutex
	closed  bool
}

// SessionID returns the session id. Sent as request_id on the wire to
// correlate worker → server frames back to this Stream.
func (s *Stream) SessionID() string { return s.sessionID }

// Recv returns the channel of inbound worker messages. The channel is closed
// when Stream.Close() is called.
func (s *Stream) Recv() <-chan *proto.WorkerMessage { return s.msgCh }

// Send forwards a payload to the worker, automatically tagging request_id
// with this session's id. Concurrent calls are serialized via the worker's
// sendMu. Accepts any of the streaming-related inner message types
// (LogsStartRequest, LogsCancelRequest, ExecStartRequest, ExecStdin,
// ExecResize, ExecCancelRequest) — the wrapper oneof is added here.
func (s *Stream) Send(payload any) error {
	s.closeMu.Lock()
	if s.closed {
		s.closeMu.Unlock()
		return fmt.Errorf("stream closed")
	}
	s.closeMu.Unlock()

	msg := &proto.ServerMessage{RequestId: s.sessionID}
	switch p := payload.(type) {
	case *proto.LogsStartRequest:
		msg.Payload = &proto.ServerMessage_LogsStart{LogsStart: p}
	case *proto.LogsCancelRequest:
		msg.Payload = &proto.ServerMessage_LogsCancel{LogsCancel: p}
	case *proto.ExecStartRequest:
		msg.Payload = &proto.ServerMessage_ExecStart{ExecStart: p}
	case *proto.ExecStdin:
		msg.Payload = &proto.ServerMessage_ExecStdin{ExecStdin: p}
	case *proto.ExecResize:
		msg.Payload = &proto.ServerMessage_ExecResize{ExecResize: p}
	case *proto.ExecCancelRequest:
		msg.Payload = &proto.ServerMessage_ExecCancel{ExecCancel: p}
	default:
		return fmt.Errorf("unsupported stream payload type: %T", payload)
	}

	s.worker.sendMu.Lock()
	defer s.worker.sendMu.Unlock()
	return s.worker.Stream.Send(msg)
}

// Close unregisters the session and closes the inbound channel. Idempotent.
// Caller is responsible for sending any logs_cancel/exec_cancel frame BEFORE
// calling Close, if a graceful cancel is desired.
func (s *Stream) Close() {
	s.closeMu.Lock()
	if s.closed {
		s.closeMu.Unlock()
		return
	}
	s.closed = true
	s.closeMu.Unlock()

	s.gateway.streamMu.Lock()
	delete(s.gateway.streams, s.sessionID)
	s.gateway.streamMu.Unlock()
	close(s.msgCh)
}

// OpenStream allocates a new session id and registers it. Returns an error
// if the cluster is not currently connected.
func (g *GatewayServer) OpenStream(clusterID string) (*Stream, error) {
	w, ok := g.GetWorker(clusterID)
	if !ok {
		return nil, fmt.Errorf("cluster %s not connected", clusterID)
	}

	s := &Stream{
		sessionID: uuid.New().String(),
		clusterID: clusterID,
		gateway:   g,
		worker:    w,
		msgCh:     make(chan *proto.WorkerMessage, streamBufferSize),
	}

	g.streamMu.Lock()
	g.streams[s.sessionID] = s
	g.streamMu.Unlock()
	return s, nil
}
