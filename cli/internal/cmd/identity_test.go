package cmd

import (
	"bytes"
	"strings"
	"testing"
)

func TestPromptForIdentity_SelectsByNumber(t *testing.T) {
	in := strings.NewReader("2\n")
	out := &bytes.Buffer{}
	prompt := promptForIdentity(in, out)

	got, err := prompt([]string{"alice", "bob"})
	if err != nil {
		t.Fatalf("prompt: %v", err)
	}
	if got != "bob" {
		t.Fatalf("got %q, want %q", got, "bob")
	}
	if !strings.Contains(out.String(), "1) alice") || !strings.Contains(out.String(), "2) bob") {
		t.Fatalf("menu not printed: %q", out.String())
	}
}

func TestPromptForIdentity_SelectsByName(t *testing.T) {
	in := strings.NewReader("alice\n")
	out := &bytes.Buffer{}
	prompt := promptForIdentity(in, out)

	got, err := prompt([]string{"alice", "bob"})
	if err != nil {
		t.Fatalf("prompt: %v", err)
	}
	if got != "alice" {
		t.Fatalf("got %q, want %q", got, "alice")
	}
}

func TestPromptForIdentity_RejectsOutOfRangeSelection(t *testing.T) {
	in := strings.NewReader("99\n")
	prompt := promptForIdentity(in, &bytes.Buffer{})

	if _, err := prompt([]string{"alice", "bob"}); err == nil {
		t.Fatal("expected an error for an out-of-range selection")
	}
}

func TestPromptForIdentity_RejectsEmptyInput(t *testing.T) {
	in := strings.NewReader("")
	prompt := promptForIdentity(in, &bytes.Buffer{})

	if _, err := prompt([]string{"alice", "bob"}); err == nil {
		t.Fatal("expected an error when no line is available to read")
	}
}

func TestIdentityCmd_HelpMentionsSourceFlag(t *testing.T) {
	root := newRootCmd("dev", "none")
	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(out)
	root.SetArgs([]string{"identity", "--help"})

	if err := root.Execute(); err != nil {
		t.Fatalf("identity --help returned an error: %v", err)
	}
	if !strings.Contains(out.String(), "--source") {
		t.Fatalf("identity --help does not document --source: %q", out.String())
	}
}
