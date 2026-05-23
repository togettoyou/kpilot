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
