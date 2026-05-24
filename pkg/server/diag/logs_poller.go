package diag

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	kplog "github.com/togettoyou/kpilot/pkg/log"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
	"github.com/togettoyou/kpilot/pkg/server/store"
)

var logsPollerLog = kplog.L("diag-logs-poller")

// LogsPoller is the sister of Poller for log lines. Same single-
// writer-per-node + reconcile-against-store.ListClusters + TTL
// janitor pattern, just pulling /debug/logs instead of /snapshot
// and batch-INSERTing into system_logs.
//
// Per-node state tracks a `lastSeq` cursor so successive pulls
// only fetch new entries. The cursor is initialized lazily on the
// first poll for each node (SELECT MAX(seq) FROM system_logs WHERE
// node_id=?), which survives server restarts: even after a crash,
// the next poll picks up where the persisted rows left off, modulo
// the worker's ring buffer retention.
//
// The 5 s cadence is faster than the snapshot poller (15 s) because
// log lines are inherently bursty — at 15 s we'd routinely drop
// hundreds of lines off the ring buffer between polls under load.
// 5 s × ~10 lines/sec/node = 50 lines/poll typical, well within
// the buffer's 50k slot capacity.
type LogsPoller struct {
	gw         *gateway.GatewayServer
	serverPort atomic.Uint32

	pollInterval time.Duration
	retention    time.Duration
	fetchTimeout time.Duration
	pullLimit    int // ?limit=N on /debug/logs

	httpClient *http.Client

	mu       sync.Mutex
	tickers  map[string]chan struct{} // nodeID → stop channel
	failing  map[string]bool          // OK→failing transition log dedup
	lastSeqs map[string]uint64        // nodeID → highest persisted seq
}

// NewLogsPoller wires the poller against the gateway (for worker
// tunnel access) and the server's own diag port (for loopback).
// Call Start to launch goroutines; the struct does no work at New
// time.
func NewLogsPoller(gw *gateway.GatewayServer, serverDiagPort uint32) *LogsPoller {
	p := &LogsPoller{
		gw:           gw,
		pollInterval: 5 * time.Second,
		// 25 h = 1 d + 1 h buffer, same as system_snapshots so the
		// landing page's "last 24h" feels consistent across panels.
		retention:    25 * time.Hour,
		fetchTimeout: 5 * time.Second,
		// 500 lines per pull. At 5 s cadence that's 6 000 lines/min,
		// well above realistic steady-state log volume; bursts beyond
		// this just spill into the next tick. The ring buffer holds
		// 50 k entries → tolerates ~8 min of full-throttle backpressure
		// before any drops.
		pullLimit: 500,
		httpClient: &http.Client{
			Transport: &http.Transport{
				MaxIdleConns:        4,
				MaxIdleConnsPerHost: 4,
				IdleConnTimeout:     30 * time.Second,
			},
		},
		tickers:  make(map[string]chan struct{}),
		failing:  make(map[string]bool),
		lastSeqs: make(map[string]uint64),
	}
	p.serverPort.Store(serverDiagPort)
	return p
}

// Start launches:
//   - reconcileLoop: every 60 s syncs the ticker set against
//     store.ListClusters (start newly-added clusters, stop deleted).
//   - janitorLoop: every 15 min DELETEs rows older than retention.
//
// Returns immediately; goroutines exit when ctx is done.
func (p *LogsPoller) Start(ctx context.Context) {
	p.reconcileOnce(ctx)
	go p.reconcileLoop(ctx)
	go p.janitorLoop(ctx)
}

// SetServerDiagPort updates the loopback port for "server" polls.
// Atomic so reads on the hot path stay lock-free.
func (p *LogsPoller) SetServerDiagPort(port uint32) {
	p.serverPort.Store(port)
}

// ─── reconcile + janitor (mirrors snapshot poller) ──────────────────

func (p *LogsPoller) reconcileLoop(ctx context.Context) {
	t := time.NewTicker(60 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.reconcileOnce(ctx)
		}
	}
}

func (p *LogsPoller) reconcileOnce(ctx context.Context) {
	want := map[string]struct{}{"server": {}}
	clusters, err := store.ListClusters()
	if err != nil {
		logsPollerLog.Warnf("reconcile: list clusters failed: %v", err)
	} else {
		for _, c := range clusters {
			want[c.ID] = struct{}{}
		}
	}

	p.mu.Lock()
	for nodeID, stop := range p.tickers {
		if _, ok := want[nodeID]; !ok {
			close(stop)
			delete(p.tickers, nodeID)
			delete(p.failing, nodeID)
			delete(p.lastSeqs, nodeID)
			logsPollerLog.Infof("stopped ticker: node=%s", nodeID)
		}
	}
	for nodeID := range want {
		if _, ok := p.tickers[nodeID]; ok {
			continue
		}
		stop := make(chan struct{})
		p.tickers[nodeID] = stop
		go p.nodeLoop(ctx, nodeID, stop)
		logsPollerLog.Infof("started ticker: node=%s", nodeID)
	}
	p.mu.Unlock()
}

func (p *LogsPoller) janitorLoop(ctx context.Context) {
	t := time.NewTicker(15 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			cutoff := time.Now().Add(-p.retention)
			n, err := store.DeleteSystemLogsBefore(cutoff)
			if err != nil {
				logsPollerLog.Warnf("janitor delete failed: %v", err)
				continue
			}
			if n > 0 {
				logsPollerLog.Infof("janitor trimmed %d rows (cutoff=%s)", n, cutoff.Format(time.RFC3339))
			}
		}
	}
}

// ─── per-node ticker ────────────────────────────────────────────────

func (p *LogsPoller) nodeLoop(ctx context.Context, nodeID string, stop <-chan struct{}) {
	defer func() {
		if r := recover(); r != nil {
			logsPollerLog.Errorf("node loop panic: node=%s panic=%v", nodeID, r)
		}
	}()

	// Stagger first poll across the window so 50 nodes don't all
	// flush at the same millisecond. Same trick as the snapshot
	// poller; halves the worst-case PG INSERT burst.
	jitter := time.Duration(rand.Int63n(int64(p.pollInterval)))
	select {
	case <-ctx.Done():
		return
	case <-stop:
		return
	case <-time.After(jitter):
	}
	p.pollOne(ctx, nodeID)

	t := time.NewTicker(p.pollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-stop:
			return
		case <-t.C:
			p.pollOne(ctx, nodeID)
		}
	}
}

func (p *LogsPoller) pollOne(ctx context.Context, nodeID string) {
	since := p.cursor(nodeID)
	fetchCtx, cancel := context.WithTimeout(ctx, p.fetchTimeout)
	defer cancel()

	resp, err := p.fetchLogs(fetchCtx, nodeID, since, p.pullLimit)
	if err != nil {
		p.mu.Lock()
		wasFailing := p.failing[nodeID]
		p.failing[nodeID] = true
		p.mu.Unlock()
		if !wasFailing {
			logsPollerLog.Warnf("fetch failed: node=%s err=%v", nodeID, err)
		}
		return
	}
	p.mu.Lock()
	wasFailing := p.failing[nodeID]
	p.failing[nodeID] = false
	p.mu.Unlock()
	if wasFailing {
		logsPollerLog.Infof("fetch recovered: node=%s", nodeID)
	}

	// Restart / clock-regression detection. If the worker's most
	// recent seq is BELOW our cursor, the worker's ring is in a
	// numerically lower space than what we last saw — only possible
	// after a restart that produced fewer entries than our cursor
	// position, or a clock regression that defeated the UnixNano
	// anchor in NewRingCore. Reset the cursor so the next tick
	// pulls from this epoch's head_seq. PG PK collisions are
	// impossible by design (the anchor puts each boot's seq in a
	// distinct numerical region), so resetting is safe.
	if resp.HeadSeq > 0 && resp.HeadSeq < since {
		logsPollerLog.Warnf(
			"node=%s seq regression detected (head_seq=%d < cursor=%d), resetting cursor",
			nodeID, resp.HeadSeq, since)
		p.mu.Lock()
		p.lastSeqs[nodeID] = 0
		p.mu.Unlock()
		return // next tick re-pulls from cursor=0
	}

	if len(resp.Lines) == 0 {
		// Even an empty pull may advance the cursor (head_seq drift
		// when nothing was new since `since`). HeadSeq is the source
		// of truth for "what's the latest in the ring".
		if resp.NextSeq > since {
			p.setCursor(nodeID, resp.NextSeq)
		}
		return
	}

	rows := make([]store.SystemLog, 0, len(resp.Lines))
	for _, e := range resp.Lines {
		var fieldsJSON []byte
		if len(e.Fields) > 0 {
			// Encode the fields map opportunistically. If it fails
			// (shouldn't — it's already a map[string]any from the
			// remote ring), just drop the fields rather than the
			// whole row.
			if b, err := json.Marshal(e.Fields); err == nil {
				fieldsJSON = b
			}
		}
		rows = append(rows, store.SystemLog{
			NodeID: nodeID,
			Seq:    e.Seq,
			At:     time.Unix(0, e.TimeNs).UTC(),
			Level:  store.ParseLogLevel(e.Level),
			Module: e.Module,
			Msg:    e.Msg,
			Fields: fieldsJSON,
		})
	}

	if err := store.BatchInsertSystemLogs(rows); err != nil {
		logsPollerLog.Errorf("insert failed: node=%s rows=%d err=%v", nodeID, len(rows), err)
		// Don't advance cursor — next poll retries the same range.
		return
	}
	// Advance cursor to the last seq in this batch.
	p.setCursor(nodeID, rows[len(rows)-1].Seq)
}

// cursor returns the highest seq already persisted for the node,
// initializing from PG on first call. Subsequent calls hit the
// in-memory map.
func (p *LogsPoller) cursor(nodeID string) uint64 {
	p.mu.Lock()
	seq, ok := p.lastSeqs[nodeID]
	p.mu.Unlock()
	if ok {
		return seq
	}
	// Lazy init from PG — survives server restart by picking up
	// wherever the persisted rows left off.
	persistedSeq, err := store.GetLatestSystemLogSeq(nodeID)
	if err != nil {
		// Lookup failure: pretend we're at the head. Worse case we
		// re-insert some already-persisted rows; the PK conflict
		// makes the next BatchInsert fail noisily.
		logsPollerLog.Warnf("cursor init failed: node=%s err=%v", nodeID, err)
		persistedSeq = 0
	}
	p.mu.Lock()
	if _, ok := p.lastSeqs[nodeID]; !ok {
		p.lastSeqs[nodeID] = persistedSeq
	}
	out := p.lastSeqs[nodeID]
	p.mu.Unlock()
	return out
}

func (p *LogsPoller) setCursor(nodeID string, seq uint64) {
	p.mu.Lock()
	if seq > p.lastSeqs[nodeID] {
		p.lastSeqs[nodeID] = seq
	}
	p.mu.Unlock()
}

// ─── fetch (loopback for server, tunnel for worker) ─────────────────

type logsResp struct {
	Lines   []*kplog.Entry `json:"lines"`
	NextSeq uint64         `json:"next_seq"`
	HeadSeq uint64         `json:"head_seq"`
}

func (p *LogsPoller) fetchLogs(ctx context.Context, nodeID string, since uint64, limit int) (*logsResp, error) {
	if nodeID == "server" {
		port := p.serverPort.Load()
		if port == 0 {
			return nil, errors.New("server diag port unset")
		}
		url := fmt.Sprintf("http://127.0.0.1:%d/debug/logs?since=%d&limit=%d", port, since, limit)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, err
		}
		resp, err := p.httpClient.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("server diag returned %d: %s", resp.StatusCode, bytes.TrimSpace(body))
		}
		var out logsResp
		if err := json.Unmarshal(body, &out); err != nil {
			return nil, fmt.Errorf("decode: %w", err)
		}
		return &out, nil
	}

	if p.gw == nil {
		return nil, errors.New("gateway unavailable")
	}
	w, ok := p.gw.GetWorker(nodeID)
	if !ok {
		return nil, errors.New("worker offline")
	}
	if w.DiagPort == 0 {
		return nil, errors.New("worker diag not enabled")
	}
	url := fmt.Sprintf("http://127.0.0.1:%d/debug/logs?since=%d&limit=%d", w.DiagPort, since, limit)
	tunnelResp, err := p.gw.SendHTTPRequest(ctx, nodeID, &gateway.HTTPRequest{
		Method: http.MethodGet,
		URL:    url,
	})
	if err != nil {
		return nil, fmt.Errorf("tunnel: %w", err)
	}
	if tunnelResp.Error != "" {
		return nil, fmt.Errorf("worker: %s", tunnelResp.Error)
	}
	if tunnelResp.Status != http.StatusOK {
		return nil, fmt.Errorf("worker diag returned %d", tunnelResp.Status)
	}
	var out logsResp
	if err := json.Unmarshal(tunnelResp.Body, &out); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	return &out, nil
}
