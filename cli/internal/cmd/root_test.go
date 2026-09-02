package cmd

import (
	"bytes"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/config"
)

// isolateConfigDir points os.UserConfigDir() at a fresh temp directory for
// the duration of the test, on every OS — see the identical helper in
// internal/config's own tests for why both env vars are set unconditionally.
// Every test that runs PersistentPreRunE (anything but --help/--version,
// which cobra short-circuits before it) needs this so it can't read or write
// the real developer's config file.
func isolateConfigDir(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("AppData", dir)
}

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
	if !strings.Contains(got, "--url") || !strings.Contains(got, "--source") {
		t.Fatalf("--help output does not list the --url/--source flags: %q", got)
	}
}

func TestRootCmdRunsWithoutArgs(t *testing.T) {
	isolateConfigDir(t)

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

// ─── Config resolution wiring ───────────────────────────────────────────────

func TestRootCmdWithNoFlagsResolvesTheDefaultConfig(t *testing.T) {
	isolateConfigDir(t)

	root := newRootCmd("dev", "none")
	root.SetOut(&bytes.Buffer{})
	root.SetArgs([]string{})

	if err := root.Execute(); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	resolved, ok := config.FromContext(root.Context())
	if !ok {
		t.Fatal("no Resolved config was attached to the command context")
	}
	if resolved.BaseURL != config.DefaultBaseURL {
		t.Fatalf("BaseURL = %q, want the default %q", resolved.BaseURL, config.DefaultBaseURL)
	}
	if resolved.Source != "" {
		t.Fatalf("Source = %q, want empty with nothing configured", resolved.Source)
	}
}

func TestRootCmdURLFlagOverridesEverything(t *testing.T) {
	isolateConfigDir(t)
	if err := config.Save(config.File{BaseURL: "https://from-config.example"}); err != nil {
		t.Fatalf("seeding config file: %v", err)
	}
	t.Setenv(config.EnvBaseURL, "https://from-env.example")

	root := newRootCmd("dev", "none")
	root.SetOut(&bytes.Buffer{})
	root.SetArgs([]string{"--url", "https://from-flag.example"})

	if err := root.Execute(); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	resolved, ok := config.FromContext(root.Context())
	if !ok {
		t.Fatal("no Resolved config was attached to the command context")
	}
	if resolved.BaseURL != "https://from-flag.example" {
		t.Fatalf("BaseURL = %q, want --url's value", resolved.BaseURL)
	}
}

func TestRootCmdEnvOverridesTheConfigFile(t *testing.T) {
	isolateConfigDir(t)
	if err := config.Save(config.File{BaseURL: "https://from-config.example"}); err != nil {
		t.Fatalf("seeding config file: %v", err)
	}
	t.Setenv(config.EnvBaseURL, "https://from-env.example")

	root := newRootCmd("dev", "none")
	root.SetOut(&bytes.Buffer{})
	root.SetArgs([]string{})

	if err := root.Execute(); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	resolved, ok := config.FromContext(root.Context())
	if !ok {
		t.Fatal("no Resolved config was attached to the command context")
	}
	if resolved.BaseURL != "https://from-env.example" {
		t.Fatalf("BaseURL = %q, want %s's value", resolved.BaseURL, config.EnvBaseURL)
	}
}

func TestRootCmdSourceFlagIsRememberedForNextRun(t *testing.T) {
	isolateConfigDir(t)

	first := newRootCmd("dev", "none")
	first.SetOut(&bytes.Buffer{})
	first.SetArgs([]string{"--source", "alice"})
	if err := first.Execute(); err != nil {
		t.Fatalf("first Execute: %v", err)
	}

	// A second, independent invocation with no --source at all should pick up
	// "alice" from the config file the first run saved — this is the "repeat
	// runs should not re-ask which identity to use" behavior.
	second := newRootCmd("dev", "none")
	second.SetOut(&bytes.Buffer{})
	second.SetArgs([]string{})
	if err := second.Execute(); err != nil {
		t.Fatalf("second Execute: %v", err)
	}

	resolved, ok := config.FromContext(second.Context())
	if !ok {
		t.Fatal("no Resolved config was attached to the second command's context")
	}
	if resolved.Source != "alice" {
		t.Fatalf("Source = %q, want the remembered %q", resolved.Source, "alice")
	}
}

func TestRootCmdSourceFlagOverridesTheRememberedOne(t *testing.T) {
	isolateConfigDir(t)
	if err := config.Save(config.File{Source: "alice"}); err != nil {
		t.Fatalf("seeding config file: %v", err)
	}

	root := newRootCmd("dev", "none")
	root.SetOut(&bytes.Buffer{})
	root.SetArgs([]string{"--source", "bob"})
	if err := root.Execute(); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	resolved, ok := config.FromContext(root.Context())
	if !ok {
		t.Fatal("no Resolved config was attached to the command context")
	}
	if resolved.Source != "bob" {
		t.Fatalf("Source = %q, want --source's value %q", resolved.Source, "bob")
	}

	f, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if f.Source != "bob" {
		t.Fatalf("config file Source = %q after the run, want it updated to %q", f.Source, "bob")
	}
}
