package cmd

import (
	"bytes"
	"encoding/json"
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

func TestContextAddUseShowRemove(t *testing.T) {
	isolateConfigDir(t)

	// 1. Add context
	root, _, _ := testRoot(t)
	root.SetArgs([]string{
		"context", "add", "staging",
		"--url", "https://staging.example.com",
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
	if showRes.Name != "staging" || showRes.URL != "https://staging.example.com" || showRes.Source != "charlie" {
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
	root.SetArgs([]string{"context", "add", "dummy", "--url", "https://dummy.example", "--network", "testnet"})
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
