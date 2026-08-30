package cmd

import (
	"bytes"
	"strings"
	"testing"
)

func TestRootCmdVersion(t *testing.T) {
	root := newRootCmd("1.2.3", "abc1234")
	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(out)
	root.SetArgs([]string{"--version"})

	if err := root.Execute(); err != nil {
		t.Fatalf("--version returned an error: %v", err)
	}

	got := out.String()
	want := "signet version 1.2.3 (commit abc1234)\n"
	if got != want {
		t.Fatalf("--version output = %q, want %q", got, want)
	}
}

func TestRootCmdHelp(t *testing.T) {
	root := newRootCmd("dev", "none")
	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(out)
	root.SetArgs([]string{"--help"})

	if err := root.Execute(); err != nil {
		t.Fatalf("--help returned an error: %v", err)
	}

	got := out.String()
	if !strings.Contains(got, "signet") {
		t.Fatalf("--help output does not mention the command name: %q", got)
	}
	if !strings.Contains(got, "Usage:") {
		t.Fatalf("--help output does not print usage: %q", got)
	}
}

func TestRootCmdRunsWithoutArgs(t *testing.T) {
	// No subcommand is implemented yet — the bare root command should still
	// print its own help rather than erroring, so `signet` alone is a
	// friendly landing page rather than a crash.
	root := newRootCmd("dev", "none")
	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(out)
	root.SetArgs([]string{})

	if err := root.Execute(); err != nil {
		t.Fatalf("running with no args returned an error: %v", err)
	}
	if !strings.Contains(out.String(), "Usage:") {
		t.Fatalf("running with no args did not print help: %q", out.String())
	}
}
