//go:build windows

package simulator

import "os"

// askToStop has no SIGTERM to send on Windows, so it kills outright; the
// grace period that follows is then just a wait for the exit.
func askToStop(p *os.Process) error { return p.Kill() }
