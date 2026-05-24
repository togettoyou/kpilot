//go:build !linux && !darwin

package diag

// Catch-all stub for platforms we haven't implemented sys-stat readers
// on. In practice this is Windows — kpilot is deployed on Linux pods
// and developed on macOS, so Windows support is a "if someone files
// an issue" item. Real Windows impl would use PSAPI's
// GetProcessMemoryInfo + GlobalMemoryStatusEx via
// golang.org/x/sys/windows, which would break pkg/diag's zero-OSS-dep
// property; would belong in a sibling package instead.

func readProcStatus() (rssBytes uint64, threads int) { return 0, 0 }
func readOpenFDs() int                               { return 0 }
func readMaxFDs() uint64                             { return 0 }
func readMemTotalBytes() uint64                      { return 0 }
