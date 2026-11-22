package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/localnet"
)

func TestDevLocalnetFlagsGoTogether(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"dev", "--ci", "--localnet"}, "does not go with --ci"},
		{[]string{"dev", "--localnet-seed"}, "go with --localnet"},
		{[]string{"dev", "--localnet-bindings", "./bindings"}, "go with --localnet"},
		{[]string{"dev", "--localnet-limits", "unlimited"}, "go with --localnet"},
		{[]string{"dev", "--localnet-keep"}, "go with --localnet"},
	} {
		isolateConfigDir(t)
		out, err := runSignet(t, tc.args...)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%v: err = %v, want %q\n%s", tc.args, err, tc.want, out)
		}
		if ExitCode(err) != 2 {
			t.Fatalf("%v: exit %d, want 2 (input error)", tc.args, ExitCode(err))
		}
	}
}

func TestDevLocalnetStopCleanup(t *testing.T) {
	dir := t.TempDir()
	statePath := filepath.Join(dir, localnet.StateFile)

	// Reused network: stop leaves state untouched and emits no stop message.
	if err := os.WriteFile(statePath, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var msgs []string
	reused := &devLocalnet{
		session:  &localnet.Session{Net: &localnet.Net{Started: false}, Dir: dir},
		progress: func(s string) { msgs = append(msgs, s) },
	}
	reused.stop()
	if _, err := os.Stat(statePath); err != nil {
		t.Fatalf("reused network removed %s: %v", statePath, err)
	}
	if len(msgs) != 0 {
		t.Fatalf("unexpected progress messages for reused network: %v", msgs)
	}

	// Started network with --localnet-keep: leaves container and state file alone.
	kept := &devLocalnet{
		session:  &localnet.Session{Net: &localnet.Net{Started: true}, Dir: dir},
		keep:     true,
		progress: func(s string) { msgs = append(msgs, s) },
	}
	kept.stop()
	if _, err := os.Stat(statePath); err != nil {
		t.Fatalf("--localnet-keep removed %s: %v", statePath, err)
	}
	if len(msgs) != 0 {
		t.Fatalf("unexpected progress messages for --localnet-keep: %v", msgs)
	}
}
