//go:build linux

package diag

import (
	"os"
	"strconv"
	"strings"
)

// readCgroupMemoryLimit returns the memory limit imposed on this
// process by its cgroup, or 0 when none is set.
//
// Lookup order:
//  1. cgroup v2 unified hierarchy: /sys/fs/cgroup/memory.max
//     ("max" = unlimited, else byte count)
//  2. cgroup v1: /sys/fs/cgroup/memory/memory.limit_in_bytes
//     (sentinel ~9.2 EiB = unlimited)
//
// Both files are namespace-aware inside containers — k8s pod sees
// its own memory.max even though /proc/meminfo reports the host
// total. That's exactly why we don't trust gopsutil's
// mem.VirtualMemory() for the limit field.
//
// Returns 0 when neither file is present or both report unlimited;
// caller (sys.go) falls back to gopsutil's host-memory total.
func readCgroupMemoryLimit() uint64 {
	// cgroup v2
	if b, err := os.ReadFile("/sys/fs/cgroup/memory.max"); err == nil {
		s := strings.TrimSpace(string(b))
		if s != "max" {
			if v, err := strconv.ParseUint(s, 10, 64); err == nil && v > 0 && v < cgroupUnlimitedSentinel {
				return v
			}
		}
	}
	// cgroup v1
	if b, err := os.ReadFile("/sys/fs/cgroup/memory/memory.limit_in_bytes"); err == nil {
		s := strings.TrimSpace(string(b))
		if v, err := strconv.ParseUint(s, 10, 64); err == nil && v > 0 && v < cgroupUnlimitedSentinel {
			return v
		}
	}
	return 0
}

// cgroupUnlimitedSentinel — cgroup v1 reports something like
// 9223372036854771712 (≈ 9 EiB, INT64_MAX rounded down to page) when
// no memory limit is set. Cgroup v2 uses the literal string "max"
// which we handle separately. Any value above this is treated as
// "unlimited" and we fall through.
const cgroupUnlimitedSentinel uint64 = 1 << 60

// readCgroupWorkingSet returns the kubelet-equivalent
// `container_memory_working_set_bytes` for the cgroup THIS process
// is in:
//
//	cgroup v2: memory.current − inactive_file (from memory.stat)
//	cgroup v1: memory.usage_in_bytes − total_inactive_file (memory.stat)
//
// This is the same formula kubelet / cAdvisor use to compute the
// MEMORY column in `kubectl top pod`. It differs from RSS (which we
// also expose) by the size of reclaimable file cache pages — for a
// busy server that mmaps lots of small files (e.g. heavy log churn,
// pprof endpoint hammering) the gap can be tens of MiB.
//
// Gated on a non-max cgroup memory limit being detected: on bare-
// metal Linux the process is in the root cgroup and the files would
// report system-wide values, which is wrong for "this process". When
// the gate fails, returns 0 and the caller (diag.go) falls back to
// RSS — fine because there's no container to align with anyway.
//
// Returns 0 when neither cgroup hierarchy is present or the limit
// gate fails — caller falls back to RSS.
func readCgroupWorkingSet() uint64 {
	if readCgroupMemoryLimit() == 0 {
		return 0
	}
	// cgroup v2
	if cur, ok := readUint64File("/sys/fs/cgroup/memory.current"); ok {
		inactive := readMemStatField("/sys/fs/cgroup/memory.stat", "inactive_file")
		if cur > inactive {
			return cur - inactive
		}
		return cur
	}
	// cgroup v1
	if cur, ok := readUint64File("/sys/fs/cgroup/memory/memory.usage_in_bytes"); ok {
		inactive := readMemStatField("/sys/fs/cgroup/memory/memory.stat", "total_inactive_file")
		if cur > inactive {
			return cur - inactive
		}
		return cur
	}
	return 0
}

// readUint64File reads a file containing a single decimal uint64.
// Returns (value, true) on success, (0, false) on any error so the
// caller can decide whether to fall through to a different path.
func readUint64File(path string) (uint64, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	v, err := strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// readMemStatField scans a cgroup memory.stat file for `key <value>`
// and returns the value (0 if the key is absent or unparseable —
// matches the semantic the caller expects for "no contribution from
// inactive_file" rather than erroring).
func readMemStatField(path, key string) uint64 {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == key {
			v, _ := strconv.ParseUint(fields[1], 10, 64)
			return v
		}
	}
	return 0
}
