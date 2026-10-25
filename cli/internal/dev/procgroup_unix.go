//go:build !windows

package dev

import (
	"os/exec"
	"syscall"
)

// ownGroup starts the build in a process group of its own, so cancelling it
// reaches cargo and rustc under stellar too.
func ownGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killGroup kills the build's whole process group.
func killGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}
