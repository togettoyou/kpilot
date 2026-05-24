package diag

import "sync/atomic"

// Package-level atomic counters reachable from any handler without
// dependency injection. The InferenceCollector below surfaces them
// in the server's diag snapshot.
//
// Handlers should bracket request handling like:
//
//	diag.InferenceInflight.Add(1)
//	defer diag.InferenceInflight.Add(-1)
//
// All counters are gauges (current state). Lifetime totals are kept
// alongside so the dashboard can show both "current concurrency"
// and "total requests since start".
var (
	// InferenceInflight — currently-streaming OpenAI-compatible
	// /v1/* requests being reverse-proxied to vLLM, both the
	// playground (cookie auth) and the bearer-key path.
	InferenceInflight atomic.Int32
	// InferenceTotal — lifetime count of inference requests handled.
	InferenceTotal atomic.Uint64

	// SSEClients — concurrent SSE writers currently held open by the
	// shared sse.go helper (logs /search, /histogram). Inference
	// streaming maintains its own counter via InferenceInflight so it
	// isn't double-counted here; if you add a new SSE-style handler,
	// either route it through startSSE (auto-instrumented) or bump
	// SSEClients explicitly with a paired defer.
	SSEClients atomic.Int32
)
