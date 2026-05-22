package gateway

import (
	"context"
	"net"
	"testing"
	"time"

	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	transportv2 "github.com/togettoyou/kpilot/pkg/transport/yamux"
)

// TestYamuxRegisterRejectsBadToken verifies the register handshake
// rejects an unknown cluster_token. Real DB is required (we use
// store.GetClusterByToken); the test sets store up against a
// shared sqlite fallback if available, else skips.
func TestYamuxRegisterRejectsBadToken(t *testing.T) {
	if !storeIsAvailable() {
		t.Skip("store not initialized — skip phase B-1 integration test")
	}
	gw := NewGatewayServer()

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer lis.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go func() { _ = gw.AcceptYamux(ctx, lis) }()

	// Client side: dial, open STREAM_REGISTER, send bad token,
	// expect RegisterAck.success=false.
	conn, err := net.Dial("tcp", lis.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	cli, err := transportv2.NewClientSession(conn, nil)
	if err != nil {
		t.Fatalf("client session: %v", err)
	}
	defer cli.Close()

	st, err := cli.Open(ctx, pbv2.StreamKind_STREAM_REGISTER, "reg", false)
	if err != nil {
		t.Fatalf("open register: %v", err)
	}
	defer st.Close()

	if err := st.WriteMsg(&pbv2.RegisterRequest{
		ClusterToken:  "definitely-not-a-real-token",
		WorkerVersion: "test",
	}); err != nil {
		t.Fatalf("write request: %v", err)
	}
	_ = st.CloseWrite()

	var ack pbv2.RegisterAck
	if err := st.ReadMsg(&ack); err != nil {
		t.Fatalf("read ack: %v", err)
	}
	if ack.GetSuccess() {
		t.Errorf("ack.success = true for bad token, want false")
	}
	if ack.GetMessage() == "" {
		t.Errorf("ack.message empty; want a rejection reason")
	}
}

// storeIsAvailable best-effort checks whether store.Init was called
// elsewhere in this test binary. Phase B-1 doesn't bring up a test
// database, so the integration test skips rather than spinning one
// up (that's phase E's territory). When phase E adds an in-memory
// sqlite-based store fixture this check becomes the gate.
func storeIsAvailable() bool {
	// Conservative: skip unless the test runner explicitly set up
	// the store. We have no public probe for that today, so always
	// return false in phase B-1 — gives us the test code in place
	// without requiring DB infra in the unit-test pass.
	return false
}
