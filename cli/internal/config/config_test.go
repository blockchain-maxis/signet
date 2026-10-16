package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// isolateConfigDir points os.UserConfigDir() at a fresh temp directory for
// the duration of the test, on every OS: Linux honors XDG_CONFIG_HOME,
// macOS ignores it and uses $HOME/Library/Application Support, and Windows
// honors AppData. Setting the ones the current OS ignores is harmless. This
// is what keeps these tests from touching the real user's config file.
//
// It returns what os.UserConfigDir() now resolves to, since on macOS that is
// a subdirectory of the temp dir rather than the temp dir itself.
func isolateConfigDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
	t.Setenv("AppData", dir)
	base, err := os.UserConfigDir()
	if err != nil {
		t.Fatalf("os.UserConfigDir: %v", err)
	}
	return base
}

func TestLoadWithNoConfigFileReturnsZeroValue(t *testing.T) {
	isolateConfigDir(t)

	f, err := Load()
	if err != nil {
		t.Fatalf("Load with no config file present returned an error: %v", err)
	}
	if f.Version != 0 || f.Current != "" || len(f.Contexts) != 0 {
		t.Fatalf("Load with no config file present = %+v, want zero value", f)
	}
}

func TestSaveThenLoadRoundTrips(t *testing.T) {
	isolateConfigDir(t)

	want := File{
		Version: 2,
		Current: "default",
		Contexts: map[string]Context{
			"default": {URL: "https://signet.example.internal", Source: "alice"},
		},
	}
	if err := Save(want); err != nil {
		t.Fatalf("Save: %v", err)
	}

	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.Version != want.Version || got.Current != want.Current || got.Contexts["default"] != want.Contexts["default"] {
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

	if err := Save(File{
		Version: 2,
		Current: "default",
		Contexts: map[string]Context{
			"default": {URL: "https://signet.example.internal"},
		},
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := RememberSource("bob"); err != nil {
		t.Fatalf("RememberSource: %v", err)
	}

	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	ctx := got.Contexts["default"]
	if ctx.URL != "https://signet.example.internal" || ctx.Source != "bob" {
		t.Fatalf("Load after RememberSource = %+v, want url preserved and source bob", ctx)
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

// ─── Acceptance test 1: v1 -> v2 migration round trip ─────────────────────

func TestV1ToV2MigrationRoundTrip(t *testing.T) {
	isolateConfigDir(t)

	path, err := Path()
	if err != nil {
		t.Fatalf("Path: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	v1Content := []byte(`{
  "baseUrl": "https://v1.example.com",
  "source": "alice"
}`)
	if err := os.WriteFile(path, v1Content, 0o600); err != nil {
		t.Fatalf("WriteFile v1: %v", err)
	}

	// 1. First Load triggers migration
	f, err := Load()
	if err != nil {
		t.Fatalf("Load v1: %v", err)
	}

	if f.Version != 2 {
		t.Errorf("Version = %d, want 2", f.Version)
	}
	if f.Current != "default" {
		t.Errorf("Current = %q, want %q", f.Current, "default")
	}
	defaultCtx, ok := f.Contexts["default"]
	if !ok {
		t.Fatalf("Contexts[\"default\"] missing")
	}
	if defaultCtx.URL != "https://v1.example.com" {
		t.Errorf("default.URL = %q, want https://v1.example.com", defaultCtx.URL)
	}
	if defaultCtx.Source != "alice" {
		t.Errorf("default.Source = %q, want alice", defaultCtx.Source)
	}

	// 2. Check that .bak backup was written with exact original v1 bytes
	bakData, err := os.ReadFile(path + ".bak")
	if err != nil {
		t.Fatalf("reading backup file: %v", err)
	}
	if string(bakData) != string(v1Content) {
		t.Errorf("backup content = %q, want %q", string(bakData), string(v1Content))
	}

	// 3. Second Load reads back migrated v2 file without rewriting backup
	f2, err := Load()
	if err != nil {
		t.Fatalf("second Load: %v", err)
	}
	if f2.Version != 2 || f2.Current != "default" || f2.Contexts["default"] != defaultCtx {
		t.Errorf("second Load mismatch: got %+v, want %+v", f2, f)
	}
}

// ─── Acceptance test 2: precedence table covering every layer ─────────────

func TestPrecedenceTableEveryLayer(t *testing.T) {
	tests := []struct {
		name        string
		opts        ResolveOptions
		file        File
		wantURL     string
		wantNetwork string
		wantSource  string
		wantContext string
	}{
		{
			name:        "all defaults when empty",
			opts:        ResolveOptions{},
			file:        File{},
			wantURL:     DefaultBaseURL,
			wantNetwork: DefaultNetwork,
			wantSource:  "",
			wantContext: DefaultContextName,
		},
		{
			name: "active context supplies values",
			opts: ResolveOptions{},
			file: File{
				Version: 2,
				Current: "staging",
				Contexts: map[string]Context{
					"staging": {
						URL:     "https://staging.signet.internal",
						Network: "mainnet",
						Source:  "alice",
					},
				},
			},
			wantURL:     "https://staging.signet.internal",
			wantNetwork: "mainnet",
			wantSource:  "alice",
			wantContext: "staging",
		},
		{
			name: "environment variables beat context",
			opts: ResolveOptions{
				EnvBaseURL:     "https://env.signet.internal",
				EnvNetwork:     "testnet",
				EnvContext:     "prod",
				EnvSignWithKey: "deployer",
			},
			file: File{
				Version: 2,
				Current: "staging",
				Contexts: map[string]Context{
					"staging": {
						URL:     "https://staging.signet.internal",
						Network: "mainnet",
						Source:  "alice",
					},
					"prod": {
						URL:     "https://prod.signet.internal",
						Network: "mainnet",
						Source:  "bob",
					},
				},
			},
			wantURL:     "https://env.signet.internal",
			wantNetwork: "testnet",
			wantSource:  "deployer",
			wantContext: "prod",
		},
		{
			name: "flags beat environment and context",
			opts: ResolveOptions{
				FlagURL:        "https://flag.signet.internal",
				FlagURLSet:     true,
				FlagNetwork:    "customnet",
				FlagNetworkSet: true,
				FlagContext:    "custom-ctx",
				FlagContextSet: true,
				FlagSource:     "charlie",
				FlagSourceSet:  true,
				EnvBaseURL:     "https://env.signet.internal",
				EnvNetwork:     "testnet",
				EnvContext:     "prod",
				EnvSignWithKey: "deployer",
			},
			file: File{
				Version: 2,
				Current: "staging",
				Contexts: map[string]Context{
					"staging": {
						URL:     "https://staging.signet.internal",
						Network: "mainnet",
						Source:  "alice",
					},
				},
			},
			wantURL:     "https://flag.signet.internal",
			wantNetwork: "customnet",
			wantSource:  "charlie",
			wantContext: "custom-ctx",
		},
		{
			name: "sign-with-key flag outranks source flag",
			opts: ResolveOptions{
				FlagSource:         "charlie",
				FlagSourceSet:      true,
				FlagSignWithKey:    "raw-secret-key",
				FlagSignWithKeySet: true,
			},
			file:        File{},
			wantURL:     DefaultBaseURL,
			wantNetwork: DefaultNetwork,
			wantSource:  "raw-secret-key",
			wantContext: DefaultContextName,
		},
		{
			name: "explicitly empty flags win over context and defaults",
			opts: ResolveOptions{
				FlagURL:        "",
				FlagURLSet:     true,
				FlagNetwork:    "",
				FlagNetworkSet: true,
			},
			file: File{
				Version: 2,
				Current: "default",
				Contexts: map[string]Context{
					"default": {URL: "https://from-context.example", Network: "mainnet"},
				},
			},
			wantURL:     "",
			wantNetwork: "",
			wantSource:  "",
			wantContext: "default",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Resolve(tt.opts, tt.file)
			if got.BaseURL != tt.wantURL {
				t.Errorf("BaseURL = %q, want %q", got.BaseURL, tt.wantURL)
			}
			if got.Network != tt.wantNetwork {
				t.Errorf("Network = %q, want %q", got.Network, tt.wantNetwork)
			}
			if got.Source != tt.wantSource {
				t.Errorf("Source = %q, want %q", got.Source, tt.wantSource)
			}
			if got.Context != tt.wantContext {
				t.Errorf("Context = %q, want %q", got.Context, tt.wantContext)
			}
		})
	}
}

// ─── Acceptance test 3: remove of current context refused with exit 2 ─────

func TestRemoveCurrentContextRefusedWithExit2(t *testing.T) {
	f := File{
		Version: 2,
		Current: "default",
		Contexts: map[string]Context{
			"default": {URL: "https://default.example", Network: "testnet"},
			"staging": {URL: "https://staging.example", Network: "testnet"},
		},
	}

	// 1. Attempting to remove the active context fails with exit code 2
	err := f.RemoveContext("default")
	if err == nil {
		t.Fatal("RemoveContext(\"default\") succeeded, want refusal")
	}

	coder, ok := err.(interface{ ExitCode() int })
	if !ok {
		t.Fatalf("error %T does not implement ExitCode()", err)
	}
	if coder.ExitCode() != exitcode.InvalidInput {
		t.Errorf("ExitCode() = %d, want %d (exit 2)", coder.ExitCode(), exitcode.InvalidInput)
	}

	// 2. Removing a non-active context succeeds
	if err := f.RemoveContext("staging"); err != nil {
		t.Fatalf("RemoveContext(\"staging\"): %v", err)
	}
	if _, exists := f.Contexts["staging"]; exists {
		t.Errorf("staging still exists in Contexts after removal")
	}
}
