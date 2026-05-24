package diag

import (
	"os"
	"runtime"
	"runtime/metrics"
	"sync"
	"time"
)

// Diag is the per-process diagnostic surface. One instance per Go
// binary; safe for concurrent use from any number of goroutines:
//
//   - Register is write-locked (rare, usually only at startup)
//   - Snapshot is serialized via sampleMu so the underlying
//     []metrics.Sample slice can be reused across reads without
//     reallocating (~5 KB / read otherwise; matters at 1 Hz forever)
//   - Custom collectors are walked under collectorsMu.RLock(),
//     each Collect() is invoked sequentially (NOT in parallel) so
//     a collector does not have to worry about being called twice
//     concurrently and the host does not pay a goroutine-spawn cost
//     for every snapshot
//
// The intentional design choice is: snapshots are cheap (microseconds)
// and called at most ~1 Hz per active subscriber, so serializing them
// behind one mutex costs nothing in practice while making the
// "histogram delta baseline" state below straightforward.
type Diag struct {
	identity Identity

	collectorsMu sync.RWMutex
	collectors   []Collector

	sampleMu  sync.Mutex
	samples   []metrics.Sample
	gcHist    histTracker
	schedHist histTracker
	sys       *sysReader
}

// New returns a Diag configured with the caller-supplied identity.
// kind is conventionally "server" or "worker" but is otherwise
// opaque — the dashboard treats it as a free-form tag.
//
// New is cheap (allocates the runtime/metrics sample slice once);
// safe to call before logger / config init.
func New(kind, name, appVersion string) *Diag {
	host, _ := os.Hostname()
	samples := make([]metrics.Sample, len(metricNames))
	for i, n := range metricNames {
		samples[i].Name = n
	}
	return &Diag{
		identity: Identity{
			Kind:       kind,
			Name:       name,
			Hostname:   host,
			PID:        os.Getpid(),
			startTime:  time.Now(),
			GoVersion:  runtime.Version(),
			GoOS:       runtime.GOOS,
			GoArch:     runtime.GOARCH,
			AppVersion: appVersion,
			// GOMAXPROCS(0) reads the current value without changing
			// it. With go.uber.org/automaxprocs called early in main,
			// this reflects the cgroup CPU quota when running in a
			// container instead of the host's CPU count — making the
			// /system/monitor CPU% denominator (wall × NumCPU)
			// accurate for bounded pods. On bare-metal or non-cgroup
			// hosts, GOMAXPROCS == NumCPU so behavior is unchanged.
			NumCPU: runtime.GOMAXPROCS(0),
		},
		samples: samples,
		sys:     newSysReader(),
	}
}

// Register adds a host-supplied collector. Stable iteration order is
// the order of registration. Re-registering with the same Name()
// replaces the prior entry (no duplicates).
func (d *Diag) Register(c Collector) {
	d.collectorsMu.Lock()
	defer d.collectorsMu.Unlock()
	for i, existing := range d.collectors {
		if existing.Name() == c.Name() {
			d.collectors[i] = c
			return
		}
	}
	d.collectors = append(d.collectors, c)
}

// Identity returns a copy of the static identity (fields are value
// types, so the receiver-side mutation is impossible by construction).
// Hosts use this to populate the /info endpoint without paying for a
// full Snapshot.
func (d *Diag) Identity() Identity {
	id := d.identity
	id.UptimeSec = time.Since(d.identity.startTime).Seconds()
	return id
}

// Snapshot assembles the current point-in-time view. Serialized via
// sampleMu — concurrent callers will queue but the critical section is
// dominated by metrics.Read (~10 µs) plus collector dispatch (host
// dependent, typically µs-range).
func (d *Diag) Snapshot() Snapshot {
	d.sampleMu.Lock()
	rt := d.readRuntimeLocked()
	d.sampleMu.Unlock()

	// Snapshot the slice under the lock — Register may in-place replace
	// an entry when re-registering a duplicate Name(), which would race
	// with iteration here. Cheap (one alloc, pointer-sized × N).
	d.collectorsMu.RLock()
	cols := make([]Collector, len(d.collectors))
	copy(cols, d.collectors)
	d.collectorsMu.RUnlock()

	var custom map[string]map[string]any
	for _, c := range cols {
		out := c.Collect()
		if out == nil {
			continue
		}
		if custom == nil {
			custom = make(map[string]map[string]any, len(cols))
		}
		custom[c.Name()] = out
	}

	id := d.identity
	id.UptimeSec = time.Since(d.identity.startTime).Seconds()

	return Snapshot{
		Identity: id,
		Runtime:  rt,
		Custom:   custom,
		At:       time.Now(),
	}
}

// readRuntimeLocked populates a RuntimeMetrics from the per-Diag
// sample slice. Caller must hold d.sampleMu.
func (d *Diag) readRuntimeLocked() RuntimeMetrics {
	metrics.Read(d.samples)

	u := func(i int) uint64 {
		s := d.samples[i]
		if s.Value.Kind() != metrics.KindUint64 {
			return 0
		}
		return s.Value.Uint64()
	}
	f := func(i int) float64 {
		s := d.samples[i]
		if s.Value.Kind() != metrics.KindFloat64 {
			return 0
		}
		return s.Value.Float64()
	}
	h := func(i int) *metrics.Float64Histogram {
		s := d.samples[i]
		if s.Value.Kind() != metrics.KindFloat64Histogram {
			return nil
		}
		return s.Value.Float64Histogram()
	}

	rt := RuntimeMetrics{
		Goroutines:           u(idxGoroutines),
		GoMaxProcs:           u(idxGoMaxProcs),
		HeapInUseBytes:       u(idxHeapInUse),
		HeapIdleBytes:        u(idxHeapIdle),
		HeapReleasedBytes:    u(idxHeapReleased),
		HeapGoalBytes:        u(idxHeapGoal),
		StackInUseBytes:      u(idxHeapStacks),
		RuntimeOverheadBytes: u(idxMetaMSpan) + u(idxMetaMCache) + u(idxProfBuckets),
		TotalMappedBytes:     u(idxTotalMapped),
		TotalAllocBytes:      u(idxTotalAlloc),
		LiveObjects:          u(idxLiveObjects),
		GCCyclesTotal:        u(idxGCCycles),
		CPUUserSeconds:        f(idxCPUUser),
		CPUScavengeSeconds:    f(idxCPUScavenge),
		CPUIdleSeconds:        f(idxCPUIdle),
		CPUGCSeconds:          f(idxCPUGC),
		MutexWaitTotalSeconds: f(idxMutexWait),
	}

	if gc := h(idxGCPauses); gc != nil {
		dcounts, dbuckets := d.gcHist.delta(gc)
		rt.GCPauseP50Seconds = percentile(dcounts, dbuckets, 0.5)
		rt.GCPauseP90Seconds = percentile(dcounts, dbuckets, 0.9)
		rt.GCPauseP99Seconds = percentile(dcounts, dbuckets, 0.99)
		rt.GCPauseMaxSeconds = histMax(dcounts, dbuckets)
	}
	if sched := h(idxSchedLatency); sched != nil {
		dcounts, dbuckets := d.schedHist.delta(sched)
		rt.SchedLatencyP50Seconds = percentile(dcounts, dbuckets, 0.5)
		rt.SchedLatencyP90Seconds = percentile(dcounts, dbuckets, 0.9)
		rt.SchedLatencyP99Seconds = percentile(dcounts, dbuckets, 0.99)
	}

	// Process + system stats via gopsutil. Kept outside sampleMu's
	// hot path conceptually but called here for one-call snapshot
	// shape; gopsutil's per-call /proc reads are ~µs each.
	if d.sys != nil {
		ps := d.sys.readProcess()
		rt.RSSBytes = ps.RSSBytes
		rt.OSThreads = ps.Threads
		rt.OpenFDs = ps.OpenFDs
		rt.ProcessCPUUserSeconds = ps.UserSeconds
		rt.ProcessCPUSystemSeconds = ps.SystemSeconds
		rt.ProcessIOReadBytes = ps.ReadBytes
		rt.ProcessIOWriteBytes = ps.WriteBytes

		sm := d.sys.readSystemMem()
		rt.SystemMemUsedBytes = sm.UsedBytes
		rt.SystemMemAvailableBytes = sm.AvailableBytes

		rt.MemTotalBytes = d.sys.readMemTotalBytes()

		// Working set: cgroup-derived in a container (matches kubectl
		// top exactly); RSS fallback when no cgroup is detected.
		// readCgroupWorkingSet is gated on a non-max cgroup memory
		// limit being present, so on bare-metal Linux (root cgroup,
		// no limit) it returns 0 and we use RSS — which is what an
		// operator would expect there since there's no container to
		// align with anyway.
		if ws := readCgroupWorkingSet(); ws > 0 {
			rt.WorkingSetBytes = ws
		} else {
			rt.WorkingSetBytes = rt.RSSBytes
		}
	}
	rt.MaxFDs = readMaxFDs()

	return rt
}

// histTracker keeps the prior cumulative bucket counts of a runtime
// histogram so percentile / max can be reported over the last sampling
// interval (not lifetime, which is monotonically smoothed and useless
// for diagnostic dashboards).
//
// Reset semantics:
//   - First call: take a baseline, return zero-length delta
//   - Bucket layout change (rare; only across Go versions): re-baseline
//   - Gap > 5 s: re-baseline (a long pause between snapshots means the
//     delta would otherwise look like a huge spike that misrepresents
//     the current rate)
//
// Not safe for concurrent use; protected by Diag.sampleMu.
type histTracker struct {
	last  []uint64
	lastT time.Time
}

func (h *histTracker) delta(cur *metrics.Float64Histogram) (counts []uint64, buckets []float64) {
	now := time.Now()
	if cur == nil {
		return nil, nil
	}
	if h.last == nil || len(h.last) != len(cur.Counts) || now.Sub(h.lastT) > 5*time.Second {
		h.last = make([]uint64, len(cur.Counts))
		copy(h.last, cur.Counts)
		h.lastT = now
		return nil, nil
	}
	counts = make([]uint64, len(cur.Counts))
	for i, c := range cur.Counts {
		if c >= h.last[i] {
			counts[i] = c - h.last[i]
		}
		h.last[i] = c
	}
	h.lastT = now
	return counts, cur.Buckets
}
