package cmd

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

// The link command's behaviour lives in internal/link (see flow_test.go),
// which is where it can be driven against fakes. What is worth pinning here is
// the command's shape — the contract a script or a CI job depends on.

func TestLinkTakesNoArguments(t *testing.T) {
	// The handle comes from whoever is signed in when they approve in the
	// browser. Accepting one here would invite typing a handle you do not own.
	cmd := newLinkCmd()
	cmd.SetArgs([]string{"alice"})
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetErr(&bytes.Buffer{})

	err := cmd.Execute()
	if err == nil {
		t.Fatal("link accepted a positional handle")
	}
	if !strings.Contains(err.Error(), "unknown command") && !strings.Contains(err.Error(), "arg") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestLinkFlags(t *testing.T) {
	cmd := newLinkCmd()
	if cmd.Flags().Lookup("no-browser") == nil {
		t.Fatal("--no-browser is missing")
	}
	// --network is the root's persistent flag now (#604), replacing link's local flag.
	root, _, _ := newTestRoot(t)
	sub, _, err := root.Find([]string{"link"})
	if err != nil || sub == nil {
		t.Fatalf("link command not found: %v", err)
	}
	if sub.InheritedFlags().Lookup("network") == nil {
		t.Fatal("link does not inherit --network from root")
	}
	if sub.LocalFlags().Lookup("network") != nil {
		t.Fatal("link declares its own --network; the root's persistent flag is the only definition")
	}

	// --json is the root's persistent flag now (#603), not a local one.
	assertInheritsJSON(t, "link")
	// --public-key is deliberately gone: the key is resolved from the local
	// stellar identity, never asserted on the command line, so that what gets
	// signed and what gets linked cannot disagree.
	if cmd.Flags().Lookup("public-key") != nil {
		t.Fatal("--public-key came back")
	}
}

func TestLinkOffersTheManualCodePromptOnlyToAPerson(t *testing.T) {
	prev := stdinIsTerminal
	t.Cleanup(func() { stdinIsTerminal = prev })

	stdinIsTerminal = func(io.Reader) bool { return true }
	if manualCodePrompt(false, strings.NewReader("")) == nil {
		t.Fatal("no prompt for a person at a terminal")
	}
	if manualCodePrompt(true, strings.NewReader("")) != nil {
		t.Fatal("--json must never prompt: stdout is promised to be one object")
	}

	stdinIsTerminal = func(io.Reader) bool { return false }
	if manualCodePrompt(false, strings.NewReader("")) != nil {
		t.Fatal("prompted although stdin is not a terminal")
	}
}
