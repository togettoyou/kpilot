//go:build linux

package diag

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// readProcStatus parses the small subset of /proc/self/status we need.
// Returns zero values on any error — the caller doesn't differentiate
// "field missing" vs "kernel hid it"; the dashboard renders 0.
func readProcStatus() (rssBytes uint64, threads int) {
	f, err := os.Open("/proc/self/status")
	if err != nil {
		return
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "VmRSS:"):
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, _ := strconv.ParseUint(fields[1], 10, 64)
				rssBytes = kb * 1024
			}
		case strings.HasPrefix(line, "Threads:"):
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				n, _ := strconv.Atoi(fields[1])
				threads = n
			}
		}
	}
	return
}

func readOpenFDs() int {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return 0
	}
	return len(entries)
}

func readMaxFDs() uint64 {
	var rl syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &rl); err != nil {
		return 0
	}
	return rl.Cur
}

// readMemTotalBytes returns the "effective" total memory the
// process can use. Tries cgroup limits first (so a 256 MiB pod on a
// 64 GiB host reports 256 MiB, not 64 GiB) and falls back to
// /proc/meminfo MemTotal when no cgroup limit is set.
//
// Lookup order:
//  1. cgroup v2 unified hierarchy: /sys/fs/cgroup/memory.max
//     ("max" = unlimited, else byte count)
//  2. cgroup v1: /sys/fs/cgroup/memory/memory.limit_in_bytes
//     (sentinel ~9.2 EiB = unlimited)
//  3. /proc/meminfo MemTotal (host total — fallback)
//
// Returns 0 only when none of the above is readable.
func readMemTotalBytes() uint64 {
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
	// host fallback
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, _ := strconv.ParseUint(fields[1], 10, 64)
				return kb * 1024
			}
			break
		}
	}
	return 0
}

// cgroupUnlimitedSentinel — cgroup v1 reports something like
// 9223372036854771712 (≈ 9 EiB, INT64_MAX rounded down to page) when
// no memory limit is set. Cgroup v2 uses the literal string "max"
// which we handle separately. Any value above this is treated as
// "unlimited" and we fall through to host MemTotal.
const cgroupUnlimitedSentinel uint64 = 1 << 60
