package diag

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/togettoyou/kpilot/pkg/server/gateway"
	"github.com/togettoyou/kpilot/pkg/server/store"
)

// Poller drives the system-monitoring history pipeline. One ticker
// goroutine per node fetches a /debug/snapshot every pollInterval
// and INSERTs the raw JSON into store.SystemSnapshots. A TTL janitor
// trims rows older than retention. A reconcile loop adds/removes
// per-node pollers as clusters get created / deleted in the store.
//
// Design choices:
//   - Single writer per node (the ticker) → no INSERT lock contention,
//     no de-dupe logic needed
//   - HTTP handlers are reader-only against the DB → strict R/W split
//   - Fetch logic mirrors the old handler/system.go fetchNodeSnapshot:
//     loopback HTTP for "server", gw.SendHTTPRequest through the
//     yamux tunnel for worker nodes
//   - Failures (worker offline, ctx timeout) skip the tick — the row
//     for that interval simply doesn't exist, chart gets a gap
//   - reconcile / janitor share one goroutine so the process stays
//     simple to reason about
type Poller struct {
	gw         *gateway.GatewayServer
	serverPort uint32

	pollInterval time.Duration
	retention    time.Duration
	fetchTimeout time.Duration
	httpClient   *http.Client

	mu      sync.Mutex
	tickers map[string]chan struct{} // nodeID → stop channel
	failing map[string]bool          // OK→failing transition log dedupe
}

// NewPoller constructs an unstarted Poller. Call Start to kick off
// the reconcile + janitor goroutines (and the per-node tickers
// they spawn).
func NewPoller(gw *gateway.GatewayServer, serverDiagPort uint32) *Poller {
	return &Poller{
		gw:           gw,
		serverPort:   serverDiagPort,
		pollInterval: 15 * time.Second,
		// 1 h window + 5 min buffer keeps last-hour reads complete
		// even when janitor lags. Effective storage growth is
		// pollInterval-bounded: 65 min × 4/min = 260 rows / node.
		retention:    65 * time.Minute,
		fetchTimeout: 5 * time.Second,
		httpClient: &http.Client{
			Transport: &http.Transport{
				MaxIdleConns:        4,
				MaxIdleConnsPerHost: 4,
				IdleConnTimeout:     30 * time.Second,
			},
			// Per-request bound via ctx; package-level timeout
			// stays 0 so the ctx is authoritative.
		},
		tickers: make(map[string]chan struct{}),
		failing: make(map[string]bool),
	}
}

// Start launches:
//   - reconcileLoop: every 60 s, sync the ticker set against
//     store.ListClusters (start newly-created clusters, stop
//     deleted ones); also keeps the always-on "server" ticker.
//   - janitorLoop: every 60 s, DELETE rows older than retention.
//
// Returns immediately. The goroutines exit when ctx is done.
func (p *Poller) Start(ctx context.Context) {
	// Bootstrap immediately so the first reconcile + janitor don't
	// wait 60 s for their first tick.
	p.reconcileOnce(ctx)

	go p.reconcileLoop(ctx)
	go p.janitorLoop(ctx)
}

// SetServerDiagPort updates the loopback port the "server" poller
// hits. Called from cmd/server/main.go after the diag listener has
// bound but possibly before Start() — either order works.
func (p *Poller) SetServerDiagPort(port uint32) {
	p.mu.Lock()
	p.serverPort = port
	p.mu.Unlock()
}

// ─── reconcile + janitor ──────────────────────────────────────────

func (p *Poller) reconcileLoop(ctx context.Context) {
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

func (p *Poller) reconcileOnce(ctx context.Context) {
	want := map[string]struct{}{"server": {}}
	clusters, err := store.ListClusters()
	if err != nil {
		log.Printf("[diag-poller] reconcile: list clusters failed: %v", err)
	} else {
		for _, c := range clusters {
			want[c.ID] = struct{}{}
		}
	}

	p.mu.Lock()
	// Stop tickers for nodes no longer in `want`.
	for nodeID, stop := range p.tickers {
		if _, ok := want[nodeID]; !ok {
			close(stop)
			delete(p.tickers, nodeID)
			delete(p.failing, nodeID)
			log.Printf("[diag-poller] stopped ticker: node=%s", nodeID)
		}
	}
	// Start tickers for nodes newly added.
	for nodeID := range want {
		if _, ok := p.tickers[nodeID]; ok {
			continue
		}
		stop := make(chan struct{})
		p.tickers[nodeID] = stop
		go p.nodeLoop(ctx, nodeID, stop)
		log.Printf("[diag-poller] started ticker: node=%s", nodeID)
	}
	p.mu.Unlock()
}

func (p *Poller) janitorLoop(ctx context.Context) {
	t := time.NewTicker(60 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			cutoff := time.Now().Add(-p.retention)
			n, err := store.DeleteSystemSnapshotsBefore(cutoff)
			if err != nil {
				log.Printf("[diag-poller] janitor delete failed: %v", err)
				continue
			}
			if n > 0 {
				log.Printf("[diag-poller] janitor trimmed %d rows (cutoff=%s)", n, cutoff.Format(time.RFC3339))
			}
		}
	}
}

// ─── per-node ticker ──────────────────────────────────────────────

func (p *Poller) nodeLoop(ctx context.Context, nodeID string, stop <-chan struct{}) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[diag-poller] node loop panic: node=%s panic=%v", nodeID, r)
		}
	}()

	// First poll fires immediately; subsequent on the ticker.
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

func (p *Poller) pollOne(ctx context.Context, nodeID string) {
	fetchCtx, cancel := context.WithTimeout(ctx, p.fetchTimeout)
	defer cancel()

	body, err := p.fetchNodeSnapshot(fetchCtx, nodeID)
	if err != nil {
		// OK → failing transition log only (avoid one-line-per-15s
		// spam when a worker stays offline for hours).
		p.mu.Lock()
		wasFailing := p.failing[nodeID]
		p.failing[nodeID] = true
		p.mu.Unlock()
		if !wasFailing {
			log.Printf("[diag-poller] fetch failed: node=%s err=%v", nodeID, err)
		}
		return
	}
	p.mu.Lock()
	wasFailing := p.failing[nodeID]
	p.failing[nodeID] = false
	p.mu.Unlock()
	if wasFailing {
		log.Printf("[diag-poller] fetch recovered: node=%s", nodeID)
	}

	if err := store.InsertSystemSnapshot(nodeID, time.Now().UTC(), body); err != nil {
		log.Printf("[diag-poller] insert failed: node=%s err=%v", nodeID, err)
	}
}

// fetchNodeSnapshot mirrors the logic that used to live in
// handler/system.go::fetchNodeSnapshot — server hits loopback, worker
// goes through the tunnel. Kept here so the poller (only writer to
// the snapshots table) is self-contained.
func (p *Poller) fetchNodeSnapshot(ctx context.Context, nodeID string) ([]byte, error) {
	if nodeID == "server" {
		p.mu.Lock()
		port := p.serverPort
		p.mu.Unlock()
		if port == 0 {
			return nil, errors.New("server diag port unset")
		}
		url := fmt.Sprintf("http://127.0.0.1:%d/debug/snapshot", port)
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
		return body, nil
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
	url := fmt.Sprintf("http://127.0.0.1:%d/debug/snapshot", w.DiagPort)
	resp, err := p.gw.SendHTTPRequest(ctx, nodeID, &gateway.HTTPRequest{
		Method: http.MethodGet,
		URL:    url,
	})
	if err != nil {
		return nil, fmt.Errorf("tunnel: %w", err)
	}
	if resp.Error != "" {
		return nil, fmt.Errorf("worker: %s", resp.Error)
	}
	if resp.Status != http.StatusOK {
		return nil, fmt.Errorf("worker diag returned %d", resp.Status)
	}
	return resp.Body, nil
}
