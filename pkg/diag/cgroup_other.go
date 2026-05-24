//go:build !linux

package diag

// macOS / Windows don't have Linux cgroups, so this always reports
// "no container memory limit". sys.go falls back to gopsutil's
// host-memory total in that case, which is correct for those OSes.
func readCgroupMemoryLimit() uint64 { return 0 }

// readCgroupWorkingSet — same story: no cgroup, no kubelet-style
// working_set. diag.go falls back to RSS, which is the right answer
// on a dev machine where there's no container to align with anyway.
func readCgroupWorkingSet() uint64 { return 0 }
