package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/jsonschema"
)

// runSandboxDoctor runs `signet sandbox doctor` against the registry RPC fixture
// answering with protocol, and a fake simulator with lanes 28 and 29.
func runSandboxDoctor(t *testing.T, protocol int, args ...string) (string, string, error) {
	t.Helper()
	isolateConfigDir(t)
	t.Setenv("FAKESIM_LANES", "28,29")
	r := newRegistryRPC(t)
	latest := r.fixture("getLatestLedger")
	latest["protocolVersion"] = protocol
	r.override["getLatestLedger"] = latest

	sim := buildFakeSimulator(t)
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "abc", "fork1"), 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(root, "abc", "fork1", "manifest.json"), []byte(`{}`), 0o600)
	deps := defaultDeps()
	deps.KeysBinary = "stellar"
	deps.ForkRoot = func() (string, error) { return root, nil }
	deps.LocateSimulator = func(context.Context, string, func(string)) (string, error) { return sim, nil }

	old := runTool
	t.Cleanup(func() { runTool = old })
	runTool = func(_ context.Context, name string, args ...string) (string, error) {
		switch name + " " + strings.Join(args, " ") {
		case "stellar --version":
			return "stellar 23.1.4 (abc)", nil
		case "cargo --version":
			return "cargo 1.91.1 (ea2d97820 2025-10-10)", nil
		case "docker --version":
			return "", &exec.Error{Name: "docker", Err: exec.ErrNotFound}
		}
		return "", errors.New("unexpected " + name)
	}

	cmd := newRootCmdWithDeps("0.0.0-test", "abc1234", deps)
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	cmd.SetOut(stdout)
	cmd.SetErr(stderr)
	cmd.SetArgs(append([]string{"sandbox", "doctor", "--rpc-url", r.srv.URL}, args...))
	err := cmd.Execute()
	return stdout.String(), stderr.String(), err
}

func TestSandboxDoctorGivesAVerdictPerNetwork(t *testing.T) {
	for _, tc := range []struct {
		protocol int
		verdict  string
		code     int
		message  string
	}{
		{29, "ok", 0, ""},
		{30, "ahead", exitcode.HostUnsupported, "testnet is on protocol 30; this signet-simulator supports 28–29. Upgrade @signet/cli"},
		{27, "behind", exitcode.HostUnsupported, "an older @signet/cli release that has a protocol 27 lane"},
	} {
		stdout, _, err := runSandboxDoctor(t, tc.protocol)
		if code := ExitCode(err); code != tc.code {
			t.Fatalf("protocol %d: exit %d (%v)", tc.protocol, code, err)
		}
		for _, want := range []string{
			"signet 0.0.0-test",
			"signet-simulator 0.0.0-fake (fake)",
			"lane p28  soroban-env-host 28.0.2, soroban-simulation 28.0.2",
			"lane p29  soroban-env-host 29.0.2",
			fmt.Sprintf("testnet   protocol %d", tc.protocol),
			tc.verdict,
			"stellar   stellar 23.1.4 (abc)",
			"cargo     cargo 1.91.1",
			"docker    missing (for --localnet)",
			"1 fork, 2 B",
			tc.message,
		} {
			if !strings.Contains(stdout, want) {
				t.Errorf("protocol %d: no %q in\n%s", tc.protocol, want, stdout)
			}
		}
	}
}

func TestSandboxDoctorJSONMatchesItsSchema(t *testing.T) {
	schema, err := jsonschema.Load(filepath.Join("..", "..", "..", "sandbox", "protocol", "schema", "v1", "cli-sandbox-doctor.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, protocol := range []int{29, 30} {
		stdout, _, _ := runSandboxDoctor(t, protocol, "--json")
		var v map[string]any
		if err := json.Unmarshal([]byte(stdout), &v); err != nil {
			t.Fatalf("not JSON: %s", stdout)
		}
		if errs := jsonschema.Validate(schema, schema, v); len(errs) > 0 {
			t.Fatalf("protocol %d: %s", protocol, strings.Join(errs, "\n  "))
		}
		nets := v["networks"].([]any)
		if got := nets[0].(map[string]any)["verdict"]; (protocol == 29) != (got == "ok") {
			t.Fatalf("protocol %d: verdict %v", protocol, got)
		}
	}
}

func TestTildePathHidesTheHomeDirectory(t *testing.T) {
	home, _ := os.UserHomeDir()
	if got := tildePath(filepath.Join(home, ".cache", "signet", "forks")); got != filepath.Join("~", ".cache", "signet", "forks") {
		t.Fatal(got)
	}
	if got := tildePath("/var/tmp/x"); got != "/var/tmp/x" {
		t.Fatal(got)
	}
}
