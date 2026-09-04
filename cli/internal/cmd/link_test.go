package cmd

import (
	"bytes"
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
	cmd.SetArgs([]string{"aquawolf"})
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
	for _, name := range []string{"json", "network", "no-browser"} {
		if cmd.Flags().Lookup(name) == nil {
			t.Fatalf("--%s is missing", name)
		}
	}
	// --public-key is deliberately gone: the key is resolved from the local
	// stellar identity, never asserted on the command line, so that what gets
	// signed and what gets linked cannot disagree.
	if cmd.Flags().Lookup("public-key") != nil {
		t.Fatal("--public-key came back")
	}
}
