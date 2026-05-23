//go:build !linux

package diag

// On non-Linux platforms we have no portable /proc-equivalent for RSS,
// thread count, or FD count. The dashboard renders these as 0 with a
// note in docs/system.md. (Darwin would need task_info via cgo;
// Windows would need PSAPI.)

func readProcStatus() (rssBytes uint64, threads int) { return 0, 0 }
func readOpenFDs() int                               { return 0 }
func readMaxFDs() uint64                             { return 0 }
