package cmd

import (
	"bytes"
	"strings"
	"testing"
)

func TestUnlinkTakesNoArguments(t *testing.T) {
	cmd := newUnlinkCmd()
	cmd.SetArgs([]string{"GABC"})
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetErr(&bytes.Buffer{})

	if err := cmd.Execute(); err == nil {
		t.Fatal("unlink accepted a positional argument")
	}
}

func TestUnlinkFlags(t *testing.T) {
	cmd := newUnlinkCmd()
	for _, name := range []string{"yes", "json"} {
		if cmd.Flags().Lookup(name) == nil {
			t.Fatalf("--%s is missing", name)
		}
	}
}

func TestConfirmUnlink_OnlyAnExplicitYesCounts(t *testing.T) {
	// #261 requires a confirmation before acting. A prompt that treats a
	// stray newline, or anything it doesn't understand, as consent is not a
	// confirmation — this is destructive.
	yes := []string{"y\n", "Y\n", "yes\n", "YES\n", "  yes  \n"}
	no := []string{"\n", "n\n", "no\n", "maybe\n", "yeah\n", "yy\n", ""}

	for _, in := range yes {
		out := &bytes.Buffer{}
		ok, err := confirmUnlink(strings.NewReader(in), out, "GABC")
		if err != nil {
			t.Fatalf("confirmUnlink(%q): %v", in, err)
		}
		if !ok {
			t.Fatalf("confirmUnlink(%q) = false, want true", in)
		}
	}
	for _, in := range no {
		out := &bytes.Buffer{}
		ok, err := confirmUnlink(strings.NewReader(in), out, "GABC")
		if err != nil {
			t.Fatalf("confirmUnlink(%q): %v", in, err)
		}
		if ok {
			t.Fatalf("confirmUnlink(%q) = true, want false", in)
		}
	}
}

func TestConfirmUnlink_ShowsTheKeyItIsAbout(t *testing.T) {
	// The identity may not be the one the developer expected, so the prompt
	// names the key rather than asking about "your wallet".
	out := &bytes.Buffer{}
	if _, err := confirmUnlink(strings.NewReader("n\n"), out, "GTHEKEY"); err != nil {
		t.Fatalf("confirmUnlink: %v", err)
	}
	if !strings.Contains(out.String(), "GTHEKEY") {
		t.Fatalf("prompt did not name the key: %q", out.String())
	}
}
