package cmd

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// No simulator anywhere: SIGNET_SIMULATOR_PATH points at nothing and PATH is
// empty. Help must not care.
func TestSandboxHelpWorksWithoutASimulator(t *testing.T) {
	t.Setenv(simulator.PathEnv, "")
	t.Setenv("PATH", t.TempDir())
	if _, err := simulator.Locate(); err == nil {
		t.Skip("a signet-simulator sits next to the test binary; cannot test its absence")
	}

	for _, args := range [][]string{{"sandbox", "--help"}, {"sandbox"}, {"help", "sandbox"}} {
		root, stdout, _ := newTestRoot(t)
		root.SetArgs(args)
		if err := root.Execute(); err != nil {
			t.Fatalf("signet %s: %v", strings.Join(args, " "), err)
		}
		if !strings.Contains(stdout.String(), "signet-simulator") {
			t.Fatalf("signet %s printed:\n%s", strings.Join(args, " "), stdout)
		}
	}

	t.Setenv(simulator.PathEnv, filepath.Join(t.TempDir(), "missing"))
	root, _, _ := newTestRoot(t)
	root.SetArgs([]string{"sandbox", "--help"})
	if err := root.Execute(); err != nil {
		t.Fatalf("help with a dangling %s: %v", simulator.PathEnv, err)
	}
}
