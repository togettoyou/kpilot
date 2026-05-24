//go:build !linux

package diag

// macOS / Windows don't have Linux cgroups, so this always reports
// "no container memory limit". sys.go falls back to gopsutil's
// host-memory total in that case, which is correct for those OSes.
func readCgroupMemoryLimit() uint64 { return 0 }
