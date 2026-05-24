package log

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// LogsHandler returns an http.Handler that serves the in-process log
// ring buffer as JSON. Mount it next to pkg/diag's /info + /snapshot
// endpoints on the same 127.0.0.1 mux:
//
//	mux := http.NewServeMux()
//	d.Mount(mux, "/debug")
//	mux.Handle("/debug/logs", kplog.LogsHandler())
//
// Query parameters:
//
//	since  uint64  — return entries with seq > since (default 0 = all)
//	limit  int     — cap entries returned (default 500, max 5000)
//
// Response:
//
//	{
//	  "lines":    [Entry, ...],   // chronological order
//	  "next_seq": uint64,         // last seq returned (use as next 'since')
//	  "head_seq": uint64           // ring's most recent seq (for "am I caught up?")
//	}
//
// 200 with empty lines when the ring is empty or the caller is already
// caught up. The endpoint is read-only and idempotent — safe to poll
// every few seconds.
//
// Cost: one mutex lock on the ring (microseconds at our scale) + JSON
// encode. The JSON encode dominates: ~1 µs / entry, so a 500-line
// response is ~500 µs. Acceptable for a /debug endpoint.
func LogsHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ring := Ring()
		if ring == nil {
			http.Error(w, "log ring not initialized", http.StatusInternalServerError)
			return
		}

		q := r.URL.Query()
		var since uint64
		if s := q.Get("since"); s != "" {
			n, err := strconv.ParseUint(s, 10, 64)
			if err != nil {
				http.Error(w, "invalid since: "+err.Error(), http.StatusBadRequest)
				return
			}
			since = n
		}
		limit := 500
		if s := q.Get("limit"); s != "" {
			n, err := strconv.Atoi(s)
			if err != nil {
				http.Error(w, "invalid limit: "+err.Error(), http.StatusBadRequest)
				return
			}
			if n > 0 {
				limit = n
			}
		}
		if limit > 5000 {
			limit = 5000
		}

		lines := ring.Snapshot(since, limit)
		var nextSeq uint64
		if n := len(lines); n > 0 {
			nextSeq = lines[n-1].Seq
		} else {
			nextSeq = since
		}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(struct {
			Lines []*Entry `json:"lines"`
			// next_seq + head_seq encoded as JSON strings for the
			// same JavaScript-precision reason as Entry.Seq —
			// post-anchor these are ~1.8e18, far beyond Number.
			NextSeq uint64 `json:"next_seq,string"`
			HeadSeq uint64 `json:"head_seq,string"`
		}{
			Lines:   lines,
			NextSeq: nextSeq,
			HeadSeq: ring.LastSeq(),
		})
	})
}
