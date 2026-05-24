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
