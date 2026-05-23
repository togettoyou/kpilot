package api

import "github.com/togettoyou/kpilot/pkg/server/api/handler"

// SetServerDiagPort is called once at startup from cmd/server/main.go
// with the port the server's diag mux bound to. Delegates to the
// handler package which actually reverse-proxies system endpoints
// to it. Indirection lives here so cmd/server/main.go does not need
// to reach into the deeper handler subtree.
func SetServerDiagPort(port uint32) {
	handler.SetServerDiagPort(port)
}
