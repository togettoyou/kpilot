package diag

import (
	"math"
	"time"
)

// Identity is the static-ish self-description of a process. Fields are
// captured once at New() and only UptimeSeconds changes per Snapshot.
type Identity struct {
	Kind     string `json:"kind"` // "server" / "worker" / caller-defined
	Name     string `json:"name"` // e.g. cluster name or "control-plane"
	Hostname string `json:"hostname"`
	PID      int    `json:"pid"`
	// startTime is kept internal — used only to compute UptimeSec on
	// each Identity() / Snapshot() call. Not exposed in JSON because
	// uptime_seconds + the snapshot's `at` already give the dashboard
	// everything it needs.
	startTime  time.Time
	UptimeSec  float64 `json:"uptime_seconds"`
	GoVersion  string  `json:"go_version"`
	GoOS       string  `json:"goos"`
	GoArch     string  `json:"goarch"`
	AppVersion string  `json:"app_version"`
	NumCPU     int     `json:"num_cpu"`
}

// RuntimeMetrics is a flat projection of the small subset of runtime/metrics
// values we surface in the dashboard. Histogram percentiles are computed
// over the delta since the previous Snapshot (so the "p99" you see is the
// last interval, not lifetime). The first Snapshot after New() returns 0
// for histogram fields — we need one prior reading to establish a baseline.
type RuntimeMetrics struct {
	Goroutines     uint64  `json:"goroutines"`
	GoMaxProcs     uint64  `json:"gomaxprocs"`
	OSThreads      int     `json:"os_threads"`

	HeapInUseBytes       uint64 `json:"heap_inuse_bytes"`
	HeapIdleBytes        uint64 `json:"heap_idle_bytes"`
	HeapReleasedBytes    uint64 `json:"heap_released_bytes"`
	HeapGoalBytes        uint64 `json:"heap_goal_bytes"`
	StackInUseBytes      uint64 `json:"stack_inuse_bytes"`
	RuntimeOverheadBytes uint64 `json:"runtime_overhead_bytes"`
	TotalMappedBytes     uint64 `json:"total_mapped_bytes"`
	TotalAllocBytes      uint64 `json:"total_alloc_bytes"`
	LiveObjects          uint64 `json:"live_objects"`
	RSSBytes             uint64 `json:"rss_bytes"`

	GCCyclesTotal     uint64  `json:"gc_cycles_total"`
	GCPauseP50Seconds float64 `json:"gc_pause_p50_seconds"`
	GCPauseP90Seconds float64 `json:"gc_pause_p90_seconds"`
	GCPauseP99Seconds float64 `json:"gc_pause_p99_seconds"`
	GCPauseMaxSeconds float64 `json:"gc_pause_max_seconds"`

	SchedLatencyP50Seconds float64 `json:"sched_latency_p50_seconds"`
	SchedLatencyP90Seconds float64 `json:"sched_latency_p90_seconds"`
	SchedLatencyP99Seconds float64 `json:"sched_latency_p99_seconds"`

	// CPU class breakdown from runtime/metrics — Go scheduler's
	// per-class view, plotted in the Scheduler tab's "CPU breakdown"
	// chart. The headline CPU% / cores numbers come from kernel
	// process counters (process_cpu_*_seconds below), not from these,
	// because runtime/metrics excludes time spent in syscall waits
	// and silently undercounts on an I/O-heavy server.
	//
	// We don't surface CPUTotalSeconds (the runtime's wall × GOMAXPROCS
	// figure) — the old per-tick % algorithm used it as a denominator
	// but the new kernel-counter algorithm uses real wall time and
	// Identity.NumCPU instead.
	CPUUserSeconds     float64 `json:"cpu_user_seconds"`
	CPUScavengeSeconds float64 `json:"cpu_scavenge_seconds"`
	CPUIdleSeconds     float64 `json:"cpu_idle_seconds"`
	CPUGCSeconds       float64 `json:"cpu_gc_seconds"`

	MutexWaitTotalSeconds float64 `json:"mutex_wait_total_seconds"`

	OpenFDs int    `json:"open_fds"`
	MaxFDs  uint64 `json:"max_fds"`

	// MemTotalBytes is the effective memory limit available to the
	// process — cgroup memory limit if running inside a constrained
	// container, otherwise host total. Works on Linux (cgroup-aware)
	// and macOS / Windows (host total via gopsutil).
	MemTotalBytes uint64 `json:"mem_total_bytes"`

	// WorkingSetBytes is the kubelet / cAdvisor equivalent of
	// `container_memory_working_set_bytes` — the same number the
	// MEMORY column of `kubectl top pod` shows. Computed from cgroup
	// v2 (`memory.current − inactive_file`) or v1
	// (`memory.usage_in_bytes − total_inactive_file`). Falls back to
	// RSSBytes when no cgroup is detected (bare-metal Linux, macOS,
	// Windows) — there's no kubelet to align with in that case.
	//
	// Use this (not RSSBytes) when the goal is "match kubectl top".
	// RSSBytes is still exposed for operators who want the raw
	// process RSS without the inactive-file deduction.
	WorkingSetBytes uint64 `json:"working_set_bytes"`

	// ProcessCPUUserSeconds + ProcessCPUSystemSeconds are
	// kernel-counted CPU times for THIS pid (from /proc/[pid]/stat on
	// Linux). More accurate than the Go-runtime cpu_user_seconds
	// fields above when the process uses cgo or runs in a cpu-
	// throttled container — the kernel sees real on-CPU time while
	// Go's accounting only covers Go-managed threads.
	ProcessCPUUserSeconds   float64 `json:"process_cpu_user_seconds"`
	ProcessCPUSystemSeconds float64 `json:"process_cpu_system_seconds"`

	// ProcessIOReadBytes + ProcessIOWriteBytes are cumulative disk
	// bytes read/written by this pid. Linux-only (gopsutil reads
	// /proc/[pid]/io); 0 elsewhere.
	ProcessIOReadBytes  uint64 `json:"process_io_read_bytes"`
	ProcessIOWriteBytes uint64 `json:"process_io_write_bytes"`

	// SystemMemUsedBytes + SystemMemAvailableBytes are the system-
	// wide view of memory pressure (not specific to our pid). In
	// containers these reflect HOST totals — for the per-container
	// cgroup limit see MemTotalBytes. Useful when an operator is
	// trying to tell apart "process is fine, host is OOM" from
	// "process is the OOM cause".
	SystemMemUsedBytes      uint64 `json:"system_mem_used_bytes"`
	SystemMemAvailableBytes uint64 `json:"system_mem_available_bytes"`
}

// Snapshot is one point-in-time JSON payload. Custom is keyed by
// Collector.Name(). At marks when the snapshot was assembled.
type Snapshot struct {
	Identity Identity                  `json:"identity"`
	Runtime  RuntimeMetrics            `json:"runtime"`
	Custom   map[string]map[string]any `json:"custom,omitempty"`
	At       time.Time                 `json:"at"`
}

// metricNames is the canonical list of runtime/metrics keys we read.
// Order matches the indices we look up in samples[] below — adding a
// new metric means appending here AND updating readRuntimeLocked.
var metricNames = []string{
	"/sched/goroutines:goroutines",
	"/sched/gomaxprocs:threads",
	"/sched/latencies:seconds",
	"/memory/classes/heap/objects:bytes",
	"/memory/classes/heap/unused:bytes",
	"/memory/classes/heap/released:bytes",
	"/memory/classes/heap/stacks:bytes",
	"/memory/classes/metadata/mspan/inuse:bytes",
	"/memory/classes/metadata/mcache/inuse:bytes",
	"/memory/classes/profiling/buckets:bytes",
	"/memory/classes/total:bytes",
	"/gc/heap/objects:objects",
	"/gc/heap/allocs:bytes",
	"/gc/heap/goal:bytes",
	"/gc/cycles/total:gc-cycles",
	"/gc/pauses:seconds",
	"/cpu/classes/user/total:cpu-seconds",
	"/cpu/classes/scavenge/total:cpu-seconds",
	"/cpu/classes/idle/total:cpu-seconds",
	"/cpu/classes/gc/total:cpu-seconds",
	"/sync/mutex/wait/total:seconds",
}

const (
	idxGoroutines = iota
	idxGoMaxProcs
	idxSchedLatency
	idxHeapInUse
	idxHeapIdle
	idxHeapReleased
	idxHeapStacks
	idxMetaMSpan
	idxMetaMCache
	idxProfBuckets
	idxTotalMapped
	idxLiveObjects
	idxTotalAlloc
	idxHeapGoal
	idxGCCycles
	idxGCPauses
	idxCPUUser
	idxCPUScavenge
	idxCPUIdle
	idxCPUGC
	idxMutexWait
)

// percentile computes the requested quantile (0–1) over a histogram
// expressed as parallel counts/buckets slices.
//
// Bucket conventions follow runtime/metrics.Float64Histogram:
//   len(counts) == len(buckets) - 1
//   counts[i] is the number of observations in [buckets[i], buckets[i+1])
//   buckets may start with -Inf or end with +Inf
//
// Returns 0 when the histogram is empty or nil.
func percentile(counts []uint64, buckets []float64, p float64) float64 {
	if len(counts) == 0 || len(buckets) < 2 {
		return 0
	}
	var total uint64
	for _, c := range counts {
		total += c
	}
	if total == 0 {
		return 0
	}
	target := uint64(math.Ceil(float64(total) * p))
	if target == 0 {
		target = 1
	}
	var acc uint64
	for i, c := range counts {
		acc += c
		if acc >= target {
			lo, hi := buckets[i], buckets[i+1]
			if math.IsInf(lo, -1) {
				lo = hi
			}
			if math.IsInf(hi, +1) {
				hi = lo
			}
			return (lo + hi) / 2
		}
	}
	last := buckets[len(buckets)-1]
	if math.IsInf(last, +1) && len(buckets) >= 2 {
		return buckets[len(buckets)-2]
	}
	return last
}

// histMax returns the upper edge of the highest non-empty bucket. Used
// for "max GC pause this interval" reporting where a percentile-based
// number understates the tail.
func histMax(counts []uint64, buckets []float64) float64 {
	if len(counts) == 0 || len(buckets) < 2 {
		return 0
	}
	for i := len(counts) - 1; i >= 0; i-- {
		if counts[i] > 0 {
			hi := buckets[i+1]
			if math.IsInf(hi, +1) {
				hi = buckets[i]
			}
			return hi
		}
	}
	return 0
}
