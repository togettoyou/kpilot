package log

import (
	"os"

	"golang.org/x/term"
)

// isTerminal reports whether w (typically os.Stderr) is attached to a
// TTY. We use it to default color on for interactive runs and off
// when piped to a log file or systemd journal.
func isTerminal(f *os.File) bool {
	if f == nil {
		return false
	}
	return term.IsTerminal(int(f.Fd()))
}
