package diag

import (
	"context"
	"os"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/process"
)

// sysReader is the cross-platform process + host stats reader,
// backed by gopsutil/v4. One reader per Diag instance (cached at
// New time) so we don't pay process.NewProcess's pid-lookup cost
// on every snapshot. All Read* methods are safe to call serially
// from one goroutine — Diag.Snapshot already serializes via
// sampleMu so there's no concurrent-use concern.
//
// gopsutil is the right tool here: it knows the proc/sysctl/PSAPI
// quirks of every supported OS, handles cgroup-aware reads of
// /proc/self/{stat,status,statm,io} correctly in containers (these
// files are namespace-aware so the values reflect the *container's*
// view, not the host), and is widely battle-tested (used by
// cAdvisor, node-exporter, k0s, gVisor, etc.).
//
// What gopsutil does NOT do automatically: cgroup memory LIMIT
// detection. mem.VirtualMemory() reads /proc/meminfo which in a
// container reports the *host* total, not the container limit. We
// detect the cgroup limit ourselves via the small reader in
// cgroup_linux.go and fall back to gopsutil for non-container or
// non-Linux machines.
type sysReader struct {
	proc *process.Process
	// procErr is captured at construction so we can downgrade silently
	// once instead of erroring every call.
	procErr error

	// timeBudget caps any single gopsutil call so a slow /proc read
	// (rare but possible under heavy fs contention) doesn't stretch
	// a 1 Hz snapshot tick into multi-second wedge.
	timeBudget time.Duration

	// memCacheMu + memCache: process.MemoryInfo() reads /proc/self/statm
	// which is cheap; we still cache for 100 ms in case multiple
	// collectors ask within one snapshot.
	memCacheMu     sync.Mutex
	memCache       *process.MemoryInfoStat
	memCacheExpiry time.Time
}

func newSysReader() *sysReader {
	p, err := process.NewProcess(int32(os.Getpid()))
	return &sysReader{
		proc:       p,
		procErr:    err,
		timeBudget: 200 * time.Millisecond,
	}
}

// processStats is the bundle of per-process numbers we surface in
// every snapshot. All fields are 0 when gopsutil couldn't read them
// (permission denied, /proc inaccessible, OS-specific gap).
type processStats struct {
	RSSBytes      uint64
	VMSBytes      uint64
	UserSeconds   float64 // kernel-counted user-mode CPU for our pid
	SystemSeconds float64 // kernel-counted kernel-mode CPU for our pid
	Threads       int
	OpenFDs       int
	ReadBytes     uint64
	WriteBytes    uint64
}

// readProcess gathers per-process stats in one pass. Each gopsutil
// call is bounded by timeBudget — if any single one wedges (e.g.
// NumFDs shelling out to lsof on a macOS without dev tools), the
// rest still complete and the field is just left at 0.
func (s *sysReader) readProcess() processStats {
	var ps processStats
	if s.proc == nil {
		return ps
	}

	ctx, cancel := context.WithTimeout(context.Background(), s.timeBudget)
	defer cancel()

	if m, err := s.proc.MemoryInfoWithContext(ctx); err == nil && m != nil {
		ps.RSSBytes = m.RSS
		ps.VMSBytes = m.VMS
	}
	if t, err := s.proc.TimesWithContext(ctx); err == nil {
		ps.UserSeconds = t.User
		ps.SystemSeconds = t.System
	}
	if n, err := s.proc.NumThreadsWithContext(ctx); err == nil {
		ps.Threads = int(n)
	}
	// NumFDs on Linux = cheap /proc/self/fd listing. On macOS gopsutil
	// uses proc_pidinfo via cgo when available — pure-Go fallback
	// shells out to lsof which is slow. We always try; the per-call
	// ctx timeout caps the worst case.
	if n, err := s.proc.NumFDsWithContext(ctx); err == nil {
		ps.OpenFDs = int(n)
	}
	// IOCounters: Linux-only (reads /proc/self/io). Returns
	// "not implemented" on other OSes — caller sees 0.
	if io, err := s.proc.IOCountersWithContext(ctx); err == nil && io != nil {
		ps.ReadBytes = io.ReadBytes
		ps.WriteBytes = io.WriteBytes
	}
	return ps
}

// systemMem returns a system-wide memory view via gopsutil. On
// Linux this reads /proc/meminfo (which in a container reports
// host values, NOT the cgroup limit — see readCgroupMemoryLimit
// in cgroup_*.go for the limit). On macOS / Windows this reads
// the native syscall and is always host-accurate.
type systemMem struct {
	TotalBytes     uint64
	UsedBytes      uint64
	AvailableBytes uint64
}

func (s *sysReader) readSystemMem() systemMem {
	ctx, cancel := context.WithTimeout(context.Background(), s.timeBudget)
	defer cancel()
	v, err := mem.VirtualMemoryWithContext(ctx)
	if err != nil || v == nil {
		return systemMem{}
	}
	return systemMem{
		TotalBytes:     v.Total,
		UsedBytes:      v.Used,
		AvailableBytes: v.Available,
	}
}

// readMemTotalBytes is the "effective" total — cgroup limit when
// running inside a constrained container, otherwise host total
// from gopsutil. Same logic as the pre-gopsutil version, just
// rewritten to delegate the host-memory part to gopsutil so we
// don't maintain a per-OS /proc/meminfo + sysctl parser.
func (s *sysReader) readMemTotalBytes() uint64 {
	if lim := readCgroupMemoryLimit(); lim > 0 {
		return lim
	}
	return s.readSystemMem().TotalBytes
}
