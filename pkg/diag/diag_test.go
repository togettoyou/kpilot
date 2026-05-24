package diag

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestNewIdentity(t *testing.T) {
	d := New("worker", "cluster-a", "v1.2.3")
	id := d.Identity()
	if id.Kind != "worker" || id.Name != "cluster-a" || id.AppVersion != "v1.2.3" {
		t.Fatalf("identity mismatch: %+v", id)
	}
	if id.GoVersion != runtime.Version() {
		t.Fatalf("go version mismatch: %s", id.GoVersion)
	}
	if id.NumCPU != runtime.GOMAXPROCS(0) {
		t.Fatalf("NumCPU mismatch: %d", id.NumCPU)
	}
	if id.PID == 0 {
		t.Fatalf("pid should be set")
	}
	if id.UptimeSec < 0 {
		t.Fatalf("uptime should be non-negative")
	}
}

func TestSnapshotRuntimeBasic(t *testing.T) {
	d := New("server", "control-plane", "test")

	// First snapshot — histograms have no baseline yet, returns 0.
	s1 := d.Snapshot()
	if s1.Runtime.Goroutines == 0 {
		t.Fatalf("goroutines should be > 0")
	}
	if s1.Runtime.GoMaxProcs == 0 {
		t.Fatalf("gomaxprocs should be > 0")
	}
	if s1.Runtime.HeapInUseBytes == 0 {
		t.Fatalf("heap in-use should be > 0")
	}

	// Force a GC then snapshot again — should have some pause data
	// in the delta interval (baseline was just taken on s1).
	runtime.GC()
	runtime.GC()
	s2 := d.Snapshot()
	if s2.Runtime.GCCyclesTotal <= s1.Runtime.GCCyclesTotal {
		t.Fatalf("GC cycles should have increased: %d → %d",
			s1.Runtime.GCCyclesTotal, s2.Runtime.GCCyclesTotal)
	}
	// GC pause p99 may legitimately be zero if pauses were sub-bucket;
	// just assert non-negative + < 1s sanity bound.
	if s2.Runtime.GCPauseP99Seconds < 0 || s2.Runtime.GCPauseP99Seconds > 1 {
		t.Fatalf("gc pause p99 out of range: %f", s2.Runtime.GCPauseP99Seconds)
	}
}

func TestSnapshotJSONRoundtrip(t *testing.T) {
	d := New("worker", "x", "v0")
	s := d.Snapshot()
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back Snapshot
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.Identity.Kind != "worker" {
		t.Fatalf("roundtrip kind: %s", back.Identity.Kind)
	}
}

type fakeCollector struct {
	name  string
	calls atomic.Int64
}

func (f *fakeCollector) Name() string { return f.name }
func (f *fakeCollector) Collect() map[string]any {
	f.calls.Add(1)
	return map[string]any{"hits": f.calls.Load()}
}

func TestRegisterAndCustom(t *testing.T) {
	d := New("server", "x", "v0")
	a := &fakeCollector{name: "a"}
	b := &fakeCollector{name: "b"}
	d.Register(a)
	d.Register(b)

	s := d.Snapshot()
	if got := s.Custom["a"]["hits"]; got != int64(1) {
		t.Fatalf("collector a hits: %v", got)
	}
	if got := s.Custom["b"]["hits"]; got != int64(1) {
		t.Fatalf("collector b hits: %v", got)
	}

	// Re-register with same name should replace, not duplicate.
	a2 := &fakeCollector{name: "a"}
	d.Register(a2)
	s2 := d.Snapshot()
	if a.calls.Load() != 1 {
		t.Fatalf("old collector a should not have been called again, got %d", a.calls.Load())
	}
	if a2.calls.Load() != 1 {
		t.Fatalf("new collector a should have been called once, got %d", a2.calls.Load())
	}
	if got := s2.Custom["a"]["hits"]; got != int64(1) {
		t.Fatalf("new a hits: %v", got)
	}
}

// TestConcurrentSnapshots is the race-detector teeth: many goroutines
// hammer Snapshot + Register at the same time and we expect no data
// races, no panics, and consistent output.
func TestConcurrentSnapshots(t *testing.T) {
	d := New("server", "x", "v0")
	for i := 0; i < 4; i++ {
		d.Register(&fakeCollector{name: "c" + string(rune('0'+i))})
	}

	var wg sync.WaitGroup
	stop := make(chan struct{})
	const readers = 8
	wg.Add(readers)
	for i := 0; i < readers; i++ {
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					s := d.Snapshot()
					if s.Runtime.Goroutines == 0 {
						t.Errorf("goroutines == 0 in concurrent snapshot")
						return
					}
				}
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 50; i++ {
			d.Register(&fakeCollector{name: "x"})
			time.Sleep(1 * time.Millisecond)
		}
	}()

	time.Sleep(80 * time.Millisecond)
	close(stop)
	wg.Wait()
}

func TestPercentile(t *testing.T) {
	// All observations in bucket 2 — every percentile should land in [2,3).
	counts := []uint64{0, 0, 100, 0, 0}
	buckets := []float64{0, 1, 2, 3, 4, 5}
	for _, p := range []float64{0.5, 0.9, 0.99} {
		v := percentile(counts, buckets, p)
		if v < 2 || v >= 3 {
			t.Fatalf("p%.0f want [2,3) got %f", p*100, v)
		}
	}
}

func TestPercentileEdgeCases(t *testing.T) {
	if got := percentile(nil, nil, 0.5); got != 0 {
		t.Fatalf("nil hist: want 0 got %f", got)
	}
	if got := percentile([]uint64{0, 0}, []float64{0, 1, 2}, 0.5); got != 0 {
		t.Fatalf("empty counts: want 0 got %f", got)
	}
	// +Inf last bucket — fall back to second-to-last edge
	counts := []uint64{0, 0, 5}
	buckets := []float64{0, 1, 2, math.Inf(1)}
	got := percentile(counts, buckets, 0.99)
	if math.IsInf(got, 0) {
		t.Fatalf("inf leaked: %f", got)
	}
}

func TestMountAndHandlers(t *testing.T) {
	d := New("server", "x", "v0")
	d.Register(&fakeCollector{name: "ya"})

	mux := http.NewServeMux()
	d.Mount(mux, "/debug")
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// /info
	resp, err := http.Get(srv.URL + "/debug/info")
	if err != nil {
		t.Fatalf("get info: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("info status: %d body=%s", resp.StatusCode, body)
	}
	var id Identity
	if err := json.Unmarshal(body, &id); err != nil {
		t.Fatalf("decode info: %v", err)
	}
	if id.Kind != "server" {
		t.Fatalf("info kind: %s", id.Kind)
	}

	// /snapshot
	resp, err = http.Get(srv.URL + "/debug/snapshot")
	if err != nil {
		t.Fatalf("get snapshot: %v", err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	var s Snapshot
	if err := json.Unmarshal(body, &s); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	if s.Custom["ya"] == nil {
		t.Fatalf("custom collector missing in snapshot: %+v", s.Custom)
	}

	// /pprof/heap should return non-empty .pb.gz body and 200
	resp, err = http.Get(srv.URL + "/debug/pprof/heap")
	if err != nil {
		t.Fatalf("get heap: %v", err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || len(body) < 16 {
		t.Fatalf("heap profile: status=%d body=%d bytes", resp.StatusCode, len(body))
	}

	// /pprof/goroutine?debug=2 should return text format
	resp, err = http.Get(srv.URL + "/debug/pprof/goroutine?debug=2")
	if err != nil {
		t.Fatalf("get goroutine: %v", err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || len(body) == 0 {
		t.Fatalf("goroutine profile: status=%d", resp.StatusCode)
	}
}

// Cache-Control should disable any intermediate caching of snapshots.
func TestNoStoreHeader(t *testing.T) {
	d := New("server", "x", "v0")
	mux := http.NewServeMux()
	d.Mount(mux, "/debug")
	srv := httptest.NewServer(mux)
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/debug/snapshot")
	if err != nil {
		t.Fatalf("get snapshot: %v", err)
	}
	defer resp.Body.Close()
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control: want no-store got %q", got)
	}
}
