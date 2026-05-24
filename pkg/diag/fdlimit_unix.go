//go:build !windows

package diag

import "syscall"

// readMaxFDs returns the per-process file-descriptor soft rlimit
// (RLIMIT_NOFILE.Cur). Identical syscall on Linux + macOS; Windows
// has neither the type nor the call, so this lives behind a build
// tag and a windows stub provides 0.
func readMaxFDs() uint64 {
	var rl syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &rl); err != nil {
		return 0
	}
	return rl.Cur
}
