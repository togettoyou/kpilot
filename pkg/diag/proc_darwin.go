//go:build darwin

package diag

import (
	"encoding/binary"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// readProcStatus returns the process RSS via /bin/ps. Open
// alternatives without cgo: (1) task_info via mach syscall — not
// exposed in stdlib `syscall`, requires `golang.org/x/sys/unix` which
// would break pkg/diag's zero-dep guarantee; (2) parse `vm_stat` —
// gives system-wide page counts, not per-process. `ps -o rss= -p
// <pid>` is a one-shot ~3 ms call on a modern Mac and is the same
// stdlib-only approach gops and others use on darwin.
//
// Thread count: macOS doesn't expose a cheap per-process thread count
// without task_info either; left at 0.
func readProcStatus() (rssBytes uint64, threads int) {
	out, err := exec.Command("/bin/ps", "-o", "rss=", "-p", strconv.Itoa(os.Getpid())).Output()
	if err != nil {
		return 0, 0
	}
	kb, err := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	if err != nil {
		return 0, 0
	}
	return kb * 1024, 0
}

// readOpenFDs: lsof is the only stdlib-reachable option and it costs
// ~50 ms per call — too expensive to run at the snapshot's 1 Hz cadence.
// Leave the count at 0 on darwin; ops can use `lsof -p <pid>` manually
// when needed. (On Linux this is a fast /proc/self/fd directory read.)
func readOpenFDs() int { return 0 }

func readMaxFDs() uint64 {
	var rl syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &rl); err != nil {
		return 0
	}
	return rl.Cur
}

// readMemTotalBytes returns physical system memory via the
// `hw.memsize` sysctl. macOS has no per-container memory limit
// concept (no cgroups), so this is always host memory.
//
// syscall.Sysctl strips trailing NUL bytes from the result; for an
// 8-byte little-endian uint64 like hw.memsize that can shrink the
// returned string when the upper bytes are zero (typical on machines
// under 256 PiB — i.e. all of them). Pad to 8 bytes before decoding.
func readMemTotalBytes() uint64 {
	raw, err := syscall.Sysctl("hw.memsize")
	if err != nil {
		return 0
	}
	b := []byte(raw)
	if len(b) > 8 {
		return 0
	}
	for len(b) < 8 {
		b = append(b, 0)
	}
	return binary.LittleEndian.Uint64(b)
}
