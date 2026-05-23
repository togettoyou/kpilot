package handler

import "sync/atomic"

// serverDiagPort holds the loopback port the server's own diag mux is
// listening on. Set once at boot via SetServerDiagPort, read on every
// /api/v1/system/server/* request by the reverse-proxy handlers.
// Atomic so set/read can happen from any goroutine without a lock.
var serverDiagPort atomic.Uint32

// SetServerDiagPort records the loopback port of the server's diag
// HTTP mux. Called from cmd/server/main.go after the listener binds.
func SetServerDiagPort(port uint32) {
	serverDiagPort.Store(port)
}

// ServerDiagPort returns the port (0 if unset).
func ServerDiagPort() uint32 {
	return serverDiagPort.Load()
}
