//go:build windows

package dev

import "os/exec"

// ownGroup has no process groups to set up on Windows.
func ownGroup(*exec.Cmd) {}

// killGroup kills the build; Windows has no group signal, so children
// stellar started are left to exit with their parent's pipes.
func killGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
