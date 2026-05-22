// Package transport is the v2 server↔worker transport layer
// (see docs/transport-v2.md). One TLS TCP connection per worker;
// hashicorp/yamux multiplexes per-RPC streams over that connection.
// This replaces the bidi gRPC + 15 hand-rolled optimizations of v1
// (priority sender, chunked transport, per-RPC cancel frames,
// rxAccumulator, etc.) — yamux gives us each of those properties
// for free as a side effect of being a SSH-style multiplexer.
//
// Package layout:
//
//   config.go  — yamux Config + TLS defaults
//   codec.go   — length-prefix proto framing + optional gzip wrap
//   stream.go  — per-stream read/write helper on top of Codec
//   session.go — yamux session bootstrap (worker dial + server listen)
//                plus the Register exchange
//
// Phase A (this commit) introduces the package alongside the existing
// gateway/tunnel code. Nothing in pkg/server/gateway or pkg/worker/tunnel
// imports this yet — that's phase B/C.
package transport

import (
	"io"
	"time"

	"github.com/hashicorp/yamux"
)

// DefaultYamuxConfig produces a yamux Config tuned for the kpilot
// worker tunnel. Values match docs/transport-v2.md §6.1.
//
//   - MaxStreamWindowSize=4MiB matches the v1 grpc InitialWindowSize;
//     fewer flow-control round-trips on cross-WAN links.
//   - AcceptBacklog=256 lets a worker have ~256 concurrent pending
//     streams without losing OpenStream calls.
//   - KeepAlive at 20s replaces the v1 grpc keepalive PING that we
//     used for liveness detection.
//   - ConnectionWriteTimeout=10s caps how long a stuck per-write can
//     hold the session before yamux RSTs.
//   - LogOutput is silenced because we route yamux internals through
//     our own [transport] log prefix when something is interesting.
func DefaultYamuxConfig() *yamux.Config {
	cfg := yamux.DefaultConfig()
	cfg.MaxStreamWindowSize = 4 * 1024 * 1024
	cfg.AcceptBacklog = 256
	cfg.EnableKeepAlive = true
	cfg.KeepAliveInterval = 20 * time.Second
	cfg.ConnectionWriteTimeout = 10 * time.Second
	cfg.LogOutput = io.Discard
	return cfg
}
