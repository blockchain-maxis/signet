package config

import (
	"os"
	"path/filepath"
	"testing"
)

// isolateConfigDir points os.UserConfigDir() at a fresh temp directory for
// the duration of the test, on every OS: Unix honors XDG_CONFIG_HOME,
// Windows honors AppData, and setting the one the current OS ignores is
// harmless. This is what keeps these tests from touching the real user's
// config file.
func isolateConfigDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("AppData", dir)
	return dir
}

func TestLoadWithNoConfigFileReturnsZeroValue(t *testing.T) {
	isolateConfigDir(t)

	f, err := Load()
	if err != nil {
		t.Fatalf("Load with no config file present returned an error: %v", err)
	}
	if f != (File{}) {
		t.Fatalf("Load with no config file present = %+v, want zero value", f)
	}
}

func TestSaveThenLoadRoundTrips(t *testing.T) {
	isolateConfigDir(t)

	want := File{BaseURL: "https://signet.example.internal", Source: "alice"}
	if err := Save(want); err != nil {
		t.Fatalf("Save: %v", err)
	}

	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got != want {
		t.Fatalf("Load after Save = %+v, want %+v", got, want)
	}
}

func TestSaveCreatesTheConfigDirectory(t *testing.T) {
	base := isolateConfigDir(t)

	if err := Save(File{Source: "alice"}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	path, err := Path()
	if err != nil {
		t.Fatalf("Path: %v", err)
	}
	if filepath.Dir(path) != filepath.Join(base, "signet") {
		t.Fatalf("config file written outside its expected directory: %s", path)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("config file was not created: %v", err)
	}
}

func TestRememberSourceUpdatesOnlySource(t *testing.T) {
	isolateConfigDir(t)

	if err := Save(File{BaseURL: "https://signet.example.internal"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := RememberSource("bob"); err != nil {
		t.Fatalf("RememberSource: %v", err)
	}

	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := File{BaseURL: "https://signet.example.internal", Source: "bob"}
	if got != want {
		t.Fatalf("Load after RememberSource = %+v, want %+v", got, want)
	}
}

func TestRememberSourceIsANoopWhenUnchanged(t *testing.T) {
	isolateConfigDir(t)

	if err := Save(File{Source: "alice"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	path, err := Path()
	if err != nil {
		t.Fatalf("Path: %v", err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat before: %v", err)
	}

	if err := RememberSource("alice"); err != nil {
		t.Fatalf("RememberSource: %v", err)
	}

	after, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat after: %v", err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatalf("RememberSource rewrote the file for an unchanged source")
	}
}

// ─── Resolve precedence: flag > env > config > default ─────────────────────

func TestResolveFallsBackToTheDefaultBaseURLWithNoConfigFile(t *testing.T) {
	got := Resolve(ResolveOptions{}, File{})
	if got.BaseURL != DefaultBaseURL {
		t.Fatalf("BaseURL = %q, want the default %q", got.BaseURL, DefaultBaseURL)
	}
	if got.Source != "" {
		t.Fatalf("Source = %q, want empty with no config and no --source", got.Source)
	}
}

func TestResolveConfigFileOverridesTheDefault(t *testing.T) {
	got := Resolve(ResolveOptions{}, File{BaseURL: "https://from-config.example", Source: "alice"})
	if got.BaseURL != "https://from-config.example" {
		t.Fatalf("BaseURL = %q, want the config file's value", got.BaseURL)
	}
	if got.Source != "alice" {
		t.Fatalf("Source = %q, want the config file's value", got.Source)
	}
}

func TestResolveEnvOverridesTheConfigFile(t *testing.T) {
	got := Resolve(
		ResolveOptions{EnvBaseURL: "https://from-env.example"},
		File{BaseURL: "https://from-config.example"},
	)
	if got.BaseURL != "https://from-env.example" {
		t.Fatalf("BaseURL = %q, want SIGNET_URL's value", got.BaseURL)
	}
}

func TestResolveFlagOverridesEverything(t *testing.T) {
	got := Resolve(
		ResolveOptions{
			FlagURL:       "https://from-flag.example",
			FlagURLSet:    true,
			FlagSource:    "bob",
			FlagSourceSet: true,
			EnvBaseURL:    "https://from-env.example",
		},
		File{BaseURL: "https://from-config.example", Source: "alice"},
	)
	if got.BaseURL != "https://from-flag.example" {
		t.Fatalf("BaseURL = %q, want --url's value", got.BaseURL)
	}
	if got.Source != "bob" {
		t.Fatalf("Source = %q, want --source's value", got.Source)
	}
}

func TestResolveAnExplicitlyEmptyFlagStillWins(t *testing.T) {
	// FlagURLSet distinguishes "--url ''" from "the flag wasn't passed" —
	// without it, an intentionally empty override would silently fall through
	// to the config file or default instead.
	got := Resolve(
		ResolveOptions{FlagURL: "", FlagURLSet: true},
		File{BaseURL: "https://from-config.example"},
	)
	if got.BaseURL != "" {
		t.Fatalf("BaseURL = %q, want the explicit empty flag value to win", got.BaseURL)
	}
}
