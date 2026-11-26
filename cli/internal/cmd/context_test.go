package cmd

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

func testRoot(t *testing.T) (root *cobra.Command, stdout, stderr *bytes.Buffer) {
	t.Helper()
	deps := defaultDeps()
	deps.KeysBinary = "/nonexistent/signet-test-stellar"
	root = newRootCmdWithDeps("test", "abc1234", deps)
	stdout, stderr = &bytes.Buffer{}, &bytes.Buffer{}
	root.SetOut(stdout)
	root.SetErr(stderr)
	root.SetIn(strings.NewReader(""))
	return root, stdout, stderr
}

func TestContextListJSON(t *testing.T) {
	isolateConfigDir(t)
	if err := config.Save(config.File{
		Version: 2,
		Current: "default",
		Contexts: map[string]config.Context{
			"default": {URL: "https://signet.example.com", Network: "testnet", Source: "alice"},
			"prod":    {URL: "https://prod.example.com", Network: "mainnet", Source: "bob"},
		},
	}); err != nil {
		t.Fatalf("seeding config: %v", err)
	}

	root, stdout, _ := testRoot(t)
	root.SetArgs([]string{"context", "list", "--json"})

	if err := root.Execute(); err != nil {
		t.Fatalf("Execute context list --json: %v", err)
	}

	var res contextListResult
	if err := json.Unmarshal(stdout.Bytes(), &res); err != nil {
		t.Fatalf("context list --json did not output valid JSON: %v, raw: %s", err, stdout.String())
	}
	if res.Current != "default" {
		t.Errorf("Current = %q, want default", res.Current)
	}
	if len(res.Contexts) != 2 {
		t.Errorf("len(Contexts) = %d, want 2", len(res.Contexts))
	}
}

func testnetDiscoveryServer(t *testing.T, toml string, status int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.well-known/stellar.toml" {
			if status != 0 && status != http.StatusOK {
				http.Error(w, "status", status)
				return
			}
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte(toml))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestContextAddUseShowRemove(t *testing.T) {
	isolateConfigDir(t)
	srv := testnetDiscoveryServer(t, testnetStellarTOML, http.StatusOK)

	// 1. Add context
	root, _, _ := testRoot(t)
	root.SetArgs([]string{
		"context", "add", "staging",
		"--url", srv.URL,
		"--network", "testnet",
		"--source", "charlie",
	})
	if err := root.Execute(); err != nil {
		t.Fatalf("context add: %v", err)
	}

	// 2. Show context
	root, stdout, _ := testRoot(t)
	root.SetArgs([]string{"context", "show", "staging", "--json"})
	if err := root.Execute(); err != nil {
		t.Fatalf("context show: %v", err)
	}
	var showRes contextShowResult
	if err := json.Unmarshal(stdout.Bytes(), &showRes); err != nil {
		t.Fatalf("json parse show: %v", err)
	}
	if showRes.Name != "staging" || showRes.URL != srv.URL || showRes.Source != "charlie" {
		t.Errorf("unexpected show result: %+v", showRes)
	}

	// 3. Switch to staging
	root, _, _ = testRoot(t)
	root.SetArgs([]string{"context", "use", "staging"})
	if err := root.Execute(); err != nil {
		t.Fatalf("context use: %v", err)
	}

	f, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if f.Current != "staging" {
		t.Errorf("Current = %q, want staging", f.Current)
	}

	// 4. Removing active context fails with exit 2
	root, _, _ = testRoot(t)
	root.SetArgs([]string{"context", "remove", "staging"})
	err = root.Execute()
	if err == nil {
		t.Fatal("expected remove active context to fail")
	}
	if ExitCode(err) != exitcode.InvalidInput {
		t.Errorf("ExitCode = %d, want %d (exit 2)", ExitCode(err), exitcode.InvalidInput)
	}

	// 5. Add dummy, switch to dummy, remove staging
	root, _, _ = testRoot(t)
	root.SetArgs([]string{"context", "add", "dummy", "--url", srv.URL, "--network", "testnet"})
	if err := root.Execute(); err != nil {
		t.Fatalf("add dummy: %v", err)
	}

	root, _, _ = testRoot(t)
	root.SetArgs([]string{"context", "use", "dummy"})
	if err := root.Execute(); err != nil {
		t.Fatalf("use dummy: %v", err)
	}

	root, _, _ = testRoot(t)
	root.SetArgs([]string{"context", "remove", "staging"})
	if err := root.Execute(); err != nil {
		t.Fatalf("remove staging: %v", err)
	}

	f, err = config.Load()
	if err != nil {
		t.Fatalf("Load after remove: %v", err)
	}
	if _, ok := f.Contexts["staging"]; ok {
		t.Errorf("staging context still exists after removal")
	}
}

// seedDefaultAndProd writes a config with two contexts, default current.
func seedDefaultAndProd(t *testing.T) {
	t.Helper()
	isolateConfigDir(t)
	if err := config.Save(config.File{
		Version: 2,
		Current: "default",
		Contexts: map[string]config.Context{
			"default": {URL: "https://default.example.com", Network: "testnet"},
			"prod":    {URL: "https://prod.example.com", Network: "mainnet"},
		},
	}); err != nil {
		t.Fatalf("seeding config: %v", err)
	}
}

// TestUnknownContextIsAConfigurationError is #913: a misspelled --context used
// to run against the hosted deployment instead of failing.
func TestUnknownContextIsAConfigurationError(t *testing.T) {
	seedDefaultAndProd(t)

	root, _, _ := testRoot(t)
	root.SetArgs([]string{"--context", "nope", "link"})
	err := root.Execute()
	if err == nil {
		t.Fatal("expected --context nope link to fail")
	}
	if got := ExitCode(err); got != exitcode.Configuration {
		t.Errorf("ExitCode = %d, want %d (exit 3)", got, exitcode.Configuration)
	}
	for _, want := range []string{`"nope"`, "default", "prod"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err.Error(), want)
		}
	}
}

// TestConfigSetActsOnTheNamedContext is the "config ignores --context" half of
// #913: the write used to land in f.Current whatever --context said.
func TestConfigSetActsOnTheNamedContext(t *testing.T) {
	seedDefaultAndProd(t)

	root, stdout, _ := testRoot(t)
	root.SetArgs([]string{"--context", "prod", "config", "set", "url", "https://new.example.com"})
	if err := root.Execute(); err != nil {
		t.Fatalf("--context prod config set url: %v", err)
	}
	if !strings.Contains(stdout.String(), `"prod"`) {
		t.Errorf("output does not name the context it wrote: %q", stdout.String())
	}

	f, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := f.Contexts["prod"].URL; got != "https://new.example.com" {
		t.Errorf("prod.url = %q, want the new value", got)
	}
	if got := f.Contexts["default"].URL; got != "https://default.example.com" {
		t.Errorf("default.url = %q, want it untouched", got)
	}
	if f.Current != "default" {
		t.Errorf("Current = %q, want default (naming a context edits it, it does not switch to it)", f.Current)
	}
}

// TestConfigGetAndContextShowUseTheResolvedContext covers the read side.
func TestConfigGetAndContextShowUseTheResolvedContext(t *testing.T) {
	seedDefaultAndProd(t)

	root, stdout, _ := testRoot(t)
	root.SetArgs([]string{"--context", "prod", "config", "get", "url", "--json"})
	if err := root.Execute(); err != nil {
		t.Fatalf("--context prod config get url: %v", err)
	}
	var get map[string]string
	if err := json.Unmarshal(stdout.Bytes(), &get); err != nil {
		t.Fatalf("config get --json: %v, raw: %s", err, stdout.String())
	}
	if get["context"] != "prod" {
		t.Errorf("config get context = %q, want prod", get["context"])
	}
	if get["value"] != "https://prod.example.com" {
		t.Errorf("config get value = %q, want prod's url", get["value"])
	}

	root, stdout, _ = testRoot(t)
	root.SetArgs([]string{"--context", "prod", "context", "show", "--json"})
	if err := root.Execute(); err != nil {
		t.Fatalf("--context prod context show: %v", err)
	}
	var show contextShowResult
	if err := json.Unmarshal(stdout.Bytes(), &show); err != nil {
		t.Fatalf("context show --json: %v, raw: %s", err, stdout.String())
	}
	if show.Name != "prod" || show.URL != "https://prod.example.com" {
		t.Errorf("context show = %+v, want prod", show)
	}
}

// TestContextAddSourceDoesNotTouchTheCurrentContext is #913: context add's
// local --source shadowed the root's, so remembering an identity for the new
// context wrote it into the current one.
func TestContextAddSourceDoesNotTouchTheCurrentContext(t *testing.T) {
	seedDefaultAndProd(t)
	srv := testnetDiscoveryServer(t, testnetStellarTOML, http.StatusOK)

	root, _, _ := testRoot(t)
	root.SetArgs([]string{
		"context", "add", "staging",
		"--url", srv.URL,
		"--network", "testnet",
		"--source", "charlie",
	})
	if err := root.Execute(); err != nil {
		t.Fatalf("context add: %v", err)
	}

	f, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := f.Contexts["default"].Source; got != "" {
		t.Errorf("default.source = %q after context add --source, want it untouched", got)
	}
	if got := f.Contexts["staging"].Source; got != "charlie" {
		t.Errorf("staging.source = %q, want charlie", got)
	}
}

// TestUnknownContextWithSourceCreatesNoContext pins the second half of the
// same bug: remembering an identity never materialises the context.
func TestUnknownContextWithSourceCreatesNoContext(t *testing.T) {
	isolateConfigDir(t)

	root, _, _ := testRoot(t)
	root.SetArgs([]string{"--context", "nope", "--source", "alice", "whoami"})
	err := root.Execute()
	if err == nil {
		t.Fatal("expected --context nope --source alice whoami to fail")
	}
	if got := ExitCode(err); got != exitcode.Configuration {
		t.Errorf("ExitCode = %d, want %d (exit 3)", got, exitcode.Configuration)
	}

	path, err := config.Path()
	if err != nil {
		t.Fatalf("config.Path: %v", err)
	}
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Fatalf("a config file was written for a context that does not exist (%v)", statErr)
	}
}

func TestConfigSubcommands(t *testing.T) {
	isolateConfigDir(t)

	// 1. set url, network, source
	root, _, _ := testRoot(t)
	root.SetArgs([]string{"config", "set", "url", "https://set.example.com"})
	if err := root.Execute(); err != nil {
		t.Fatalf("config set url: %v", err)
	}

	root, _, _ = testRoot(t)
	root.SetArgs([]string{"config", "set", "network", "mainnet"})
	if err := root.Execute(); err != nil {
		t.Fatalf("config set network: %v", err)
	}

	root, _, _ = testRoot(t)
	root.SetArgs([]string{"config", "set", "source", "alice"})
	if err := root.Execute(); err != nil {
		t.Fatalf("config set source: %v", err)
	}

	// 2. get
	root, stdout, _ := testRoot(t)
	root.SetArgs([]string{"config", "get", "url"})
	if err := root.Execute(); err != nil {
		t.Fatalf("config get url: %v", err)
	}
	if strings.TrimSpace(stdout.String()) != "https://set.example.com" {
		t.Errorf("get url = %q, want https://set.example.com", stdout.String())
	}

	// 3. unset
	root, _, _ = testRoot(t)
	root.SetArgs([]string{"config", "unset", "source"})
	if err := root.Execute(); err != nil {
		t.Fatalf("config unset source: %v", err)
	}

	f, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if f.CurrentContext().Source != "" {
		t.Errorf("Source after unset = %q, want empty", f.CurrentContext().Source)
	}

	// 4. path
	root, stdout, _ = testRoot(t)
	root.SetArgs([]string{"config", "path"})
	if err := root.Execute(); err != nil {
		t.Fatalf("config path: %v", err)
	}
	expectedPath, _ := config.Path()
	if strings.TrimSpace(stdout.String()) != expectedPath {
		t.Errorf("config path = %q, want %q", stdout.String(), expectedPath)
	}

	// 5. invalid key fails with exit 2
	root, _, _ = testRoot(t)
	root.SetArgs([]string{"config", "get", "invalid-key"})
	err = root.Execute()
	if err == nil {
		t.Fatal("expected config get invalid-key to fail")
	}
	if ExitCode(err) != exitcode.InvalidInput {
		t.Errorf("ExitCode = %d, want %d (exit 2)", ExitCode(err), exitcode.InvalidInput)
	}
}

func TestContextAddDiscoveryRPCAndForce(t *testing.T) {
	t.Run("discovers network from stellar.toml and saves rpc-url without mutating current context", func(t *testing.T) {
		isolateConfigDir(t)
		srv := testnetDiscoveryServer(t, testnetStellarTOML, http.StatusOK)

		root, stdout, _ := testRoot(t)
		root.SetArgs([]string{
			"context", "add", "discovered",
			"--url", srv.URL,
			"--rpc-url", "https://rpc.example.com",
			"--source", "alice",
			"--json",
		})
		if err := root.Execute(); err != nil {
			t.Fatalf("context add: %v", err)
		}

		var res contextAddResult
		if err := json.Unmarshal(stdout.Bytes(), &res); err != nil {
			t.Fatalf("json parse: %v, raw: %s", err, stdout.String())
		}
		if res.Network != "testnet" || !res.Discovered || res.RPCURL != "https://rpc.example.com" {
			t.Errorf("unexpected JSON result: %+v", res)
		}

		f, err := config.Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if f.Contexts["discovered"].RPCURL != "https://rpc.example.com" {
			t.Errorf("RPCURL = %q, want https://rpc.example.com", f.Contexts["discovered"].RPCURL)
		}
		if f.Contexts[config.DefaultContextName].Source != "" {
			t.Errorf("context add mutated default context source: %q", f.Contexts[config.DefaultContextName].Source)
		}
	})

	t.Run("mismatch between --network and stellar.toml exits 3", func(t *testing.T) {
		isolateConfigDir(t)
		srv := testnetDiscoveryServer(t, testnetStellarTOML, http.StatusOK)

		root, _, _ := testRoot(t)
		root.SetArgs([]string{"context", "add", "badnet", "--url", srv.URL, "--network", "mainnet"})
		err := root.Execute()
		if err == nil {
			t.Fatal("expected mismatch error")
		}
		if ExitCode(err) != exitcode.Configuration {
			t.Errorf("ExitCode = %d, want %d (exit 3); err=%v", ExitCode(err), exitcode.Configuration, err)
		}
	})

	t.Run("no stellar.toml and no --network exits 2 with reason", func(t *testing.T) {
		isolateConfigDir(t)
		srv := testnetDiscoveryServer(t, "", http.StatusNotFound)

		root, _, _ := testRoot(t)
		root.SetArgs([]string{"context", "add", "missing", "--url", srv.URL})
		err := root.Execute()
		if err == nil {
			t.Fatal("expected missing network error")
		}
		if ExitCode(err) != exitcode.InvalidInput {
			t.Errorf("ExitCode = %d, want %d (exit 2); err=%v", ExitCode(err), exitcode.InvalidInput, err)
		}
		if !strings.Contains(err.Error(), "stellar.toml") {
			t.Errorf("expected error naming stellar.toml, got %q", err.Error())
		}
	})

	t.Run("duplicate without --force exits 2 and with --force replaces", func(t *testing.T) {
		isolateConfigDir(t)
		srv := testnetDiscoveryServer(t, testnetStellarTOML, http.StatusOK)

		root, _, _ := testRoot(t)
		root.SetArgs([]string{"context", "add", "dup", "--url", srv.URL})
		if err := root.Execute(); err != nil {
			t.Fatalf("first add: %v", err)
		}

		root, _, _ = testRoot(t)
		root.SetArgs([]string{"context", "add", "dup", "--url", srv.URL, "--rpc-url", "https://new-rpc.example.com"})
		err := root.Execute()
		if err == nil {
			t.Fatal("expected duplicate without --force to fail")
		}
		if ExitCode(err) != exitcode.InvalidInput {
			t.Errorf("ExitCode = %d, want %d (exit 2)", ExitCode(err), exitcode.InvalidInput)
		}

		root, _, _ = testRoot(t)
		root.SetArgs([]string{"context", "add", "dup", "--url", srv.URL, "--rpc-url", "https://new-rpc.example.com", "--force"})
		if err := root.Execute(); err != nil {
			t.Fatalf("replace with --force: %v", err)
		}
		f, err := config.Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if f.Contexts["dup"].RPCURL != "https://new-rpc.example.com" {
			t.Errorf("RPCURL = %q, want https://new-rpc.example.com", f.Contexts["dup"].RPCURL)
		}
	})
}
