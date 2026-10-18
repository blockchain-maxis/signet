package cmd

import (
	"os/exec"
	"path/filepath"
	"testing"
)

func TestNpmShimForwardsCompleteArgs(t *testing.T) {
	nodeBin, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node binary not found on PATH: %v", err)
	}
	testScript := filepath.Join("..", "..", "npm", "cli", "bin", "signet.test.js")
	cmd := exec.Command(nodeBin, "--test", testScript)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("node --test %s failed: %v\n%s", testScript, err, out)
	}
}
