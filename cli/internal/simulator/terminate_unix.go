//go:build !windows

package simulator

import (
	"os"
	"syscall"
)

// askToStop sends SIGTERM, the polite half of §4's stop sequence.
func askToStop(p *os.Process) error { return p.Signal(syscall.SIGTERM) }
