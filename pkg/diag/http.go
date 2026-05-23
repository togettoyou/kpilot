package diag

import (
	"encoding/json"
	"net/http"
	nethttppprof "net/http/pprof"
	"strings"
)

// Mount registers diag's HTTP handlers under prefix on mux. Conventional
// prefix is "/debug". Mount installs:
//
//	GET  <prefix>/info             — static Identity (cheap; no metrics read)
//	GET  <prefix>/snapshot         — full Snapshot (Identity + runtime + custom)
//	GET  <prefix>/pprof/heap       — pprof heap profile (.pb.gz)
//	GET  <prefix>/pprof/goroutine  — goroutine profile
//	GET  <prefix>/pprof/allocs     — alloc-objects profile
//	GET  <prefix>/pprof/block      — sync-blocked profile
//	GET  <prefix>/pprof/mutex      — mutex-contention profile
//	GET  <prefix>/pprof/threadcreate — thread-creation profile
//	GET  <prefix>/pprof/profile    — CPU profile (default 30 s)  ← cost
//	GET  <prefix>/pprof/trace      — execution tracer            ← cost
//	GET  <prefix>/pprof/cmdline    — process command line
//	GET  <prefix>/pprof/symbol     — symbol resolution
//
// All paths are exact-match — the host is responsible for surrounding
// authentication (e.g. binding the listener to 127.0.0.1, or wrapping
// the mux in a JWT middleware). Mount does not concern itself with
// access control; the listener choice is the security boundary.
//
// pprof handlers are pulled directly from stdlib net/http/pprof
// (Handler("name") for the predefined profiles, the named exported
// funcs for the others). We don't install pprof.Index because it
// hardcodes the "/debug/pprof/" prefix when extracting profile names,
// which would constrain the host's choice of mount prefix.
func (d *Diag) Mount(mux *http.ServeMux, prefix string) {
	prefix = strings.TrimRight(prefix, "/")

	mux.HandleFunc(prefix+"/info", d.handleInfo)
	mux.HandleFunc(prefix+"/snapshot", d.handleSnapshot)

	mux.HandleFunc(prefix+"/pprof/cmdline", nethttppprof.Cmdline)
	mux.HandleFunc(prefix+"/pprof/profile", nethttppprof.Profile)
	mux.HandleFunc(prefix+"/pprof/symbol", nethttppprof.Symbol)
	mux.HandleFunc(prefix+"/pprof/trace", nethttppprof.Trace)

	for _, name := range []string{"heap", "goroutine", "allocs", "block", "mutex", "threadcreate"} {
		mux.Handle(prefix+"/pprof/"+name, nethttppprof.Handler(name))
	}
}

func (d *Diag) handleInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, d.Identity())
}

func (d *Diag) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, d.Snapshot())
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	enc := json.NewEncoder(w)
	_ = enc.Encode(v)
}
