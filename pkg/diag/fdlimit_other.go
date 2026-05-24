//go:build windows

package diag

// readMaxFDs — Windows has no POSIX file-descriptor rlimit (it uses
// HANDLE quotas managed differently). We just return 0 so the
// max_fds field is harmlessly empty; the open_fds counter, populated
// from gopsutil's process.NumFDs (which on Windows is HANDLE count),
// still reports something meaningful.
func readMaxFDs() uint64 { return 0 }
