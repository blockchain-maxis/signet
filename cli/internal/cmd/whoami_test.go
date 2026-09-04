package cmd

import (
	"bytes"
	"strings"
	"testing"
)

func TestWhoamiTakesNoArguments(t *testing.T) {
	cmd := newWhoamiCmd()
	cmd.SetArgs([]string{"extra"})
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetErr(&bytes.Buffer{})

	if err := cmd.Execute(); err == nil {
		t.Fatal("whoami accepted a positional argument")
	}
}

func TestWhoamiHasJSONOutput(t *testing.T) {
	if newWhoamiCmd().Flags().Lookup("json") == nil {
		t.Fatal("--json is missing")
	}
}

func TestWhoamiHelpNeverSuggestsASecret(t *testing.T) {
	// #260 is explicit that this must never print a secret key. The command
	// has no way to read one — the public key comes from `stellar keys
	// address` — so what is worth pinning is that its own text never invites
	// one either.
	cmd := newWhoamiCmd()
	text := cmd.Long + " " + cmd.Short
	for _, forbidden := range []string{"secret key S", "--secret", "seed phrase"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("help text mentions %q", forbidden)
		}
	}
	if !strings.Contains(cmd.Long, "Never prints a secret key") {
		t.Fatal("help text does not state the guarantee")
	}
}
