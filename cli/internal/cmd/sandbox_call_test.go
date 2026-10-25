package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/jsonschema"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// realSimulator is a built signet-simulator: $SIGNET_SIMULATOR_PATH, or the
// sandbox's debug build. These tests run the real host against the recorded
// registry; without a build they are skipped (CI's sandbox job builds it and
// runs them).
func realSimulator(t *testing.T) string {
	t.Helper()
	path := os.Getenv("SIGNET_SIMULATOR_PATH")
	if path == "" {
		name := "signet-simulator"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		path = filepath.Join("..", "..", "..", "sandbox", "target", "debug", name)
	}
	if _, err := os.Stat(path); err != nil {
		t.Skipf("no built signet-simulator at %s (cargo build in sandbox/, or set SIGNET_SIMULATOR_PATH)", path)
	}
	abs, _ := filepath.Abs(path)
	return abs
}

// callEnv is one isolated config dir, fork cache and fixture RPC shared by
// a test's calls.
type callEnv struct {
	t    *testing.T
	rpc  *registryRPC
	root string
	sim  string
}

func newCallEnv(t *testing.T) *callEnv {
	isolateConfigDir(t)
	return &callEnv{t: t, rpc: newRegistryRPC(t), root: t.TempDir(), sim: realSimulator(t)}
}

func (e *callEnv) run(args ...string) (stdout, stderr string, err error) {
	e.t.Helper()
	deps := defaultDeps()
	deps.KeysBinary = "/nonexistent/signet-test-stellar"
	deps.ForkRoot = func() (string, error) { return e.root, nil }
	deps.LocateSimulator = func(context.Context, string, func(string)) (string, error) { return e.sim, nil }
	deps.Now = func() time.Time { return time.Unix(1790458610, 0) }
	cmd := newRootCmdWithDeps("0.0.0-test", "abc1234", deps)
	out, errOut := &bytes.Buffer{}, &bytes.Buffer{}
	cmd.SetOut(out)
	cmd.SetErr(errOut)
	cmd.SetIn(strings.NewReader(""))
	cmd.SetArgs(append([]string{"sandbox", "call", "--rpc-url", e.rpc.srv.URL}, args...))
	err = cmd.Execute()
	return out.String(), errOut.String(), err
}

func (e *callEnv) json(args ...string) CallResult {
	e.t.Helper()
	stdout, stderr, err := e.run(append(args, "--json")...)
	if err != nil {
		e.t.Fatalf("call %v: %v\nstderr: %s", args, err, stderr)
	}
	var res CallResult
	if err := json.Unmarshal([]byte(stdout), &res); err != nil {
		e.t.Fatalf("stdout is not one JSON object: %v\n%s", err, stdout)
	}
	return res
}

const testWallet = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"

func TestSandboxCallCountOnTheRegistry(t *testing.T) {
	e := newCallEnv(t)
	stdout, stderr, err := e.run(registryContract, "count")
	if err != nil {
		t.Fatalf("%v\nstderr: %s", err, stderr)
	}
	// count is a read: the value, the auth warning, and what it ran against.
	if !strings.Contains(stdout, "→ ") || !strings.Contains(stdout, "ran against testnet · fork ledger 4887004") ||
		!strings.Contains(stdout, "protocol 28 lane") || strings.Contains(stdout, "Would write") {
		t.Fatalf("stdout:\n%s", stdout)
	}
	claim, _, err := e.run(registryContract, "claim", "--arg", "handle=render-check", "--arg", "wallet="+testWallet)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Would write", "requires auth from GA5Z…ZVN (claim)", "Local sandbox: nothing was submitted to testnet", "⚠ auth mocked"} {
		if !strings.Contains(claim, want) {
			t.Errorf("claim rendering lacks %q:\n%s", want, claim)
		}
	}
	res := e.json(registryContract, "count")
	if res.Outcome != "result" || res.ForkLedger != registryLedger || len(res.ReturnValue) == 0 {
		t.Fatalf("result = %+v", res)
	}
}

func TestSandboxCallSessionsChainState(t *testing.T) {
	e := newCallEnv(t)
	claim := e.json(registryContract, "claim", "--arg", "handle=sandbox-test", "--arg", "wallet="+testWallet, "--session", "s1")
	if claim.Outcome != "result" || len(claim.Auth) != 1 || len(claim.Modified) == 0 {
		t.Fatalf("claim = %+v", claim)
	}

	got := e.json(registryContract, "resolve", "--arg", "handle=sandbox-test", "--session", "s1")
	if string(got.ReturnValue) != `"`+testWallet+`"` {
		t.Fatalf("resolve in the session = %s", got.ReturnValue)
	}
	fresh := e.json(registryContract, "resolve", "--arg", "handle=sandbox-test")
	if string(fresh.ReturnValue) != "null" {
		t.Fatalf("resolve without the session = %s", fresh.ReturnValue)
	}

	// A second claim in the session is the contract refusing, not a failure.
	again := e.json(registryContract, "claim", "--arg", "handle=sandbox-test", "--arg", "wallet="+testWallet, "--session", "s1")
	if again.Outcome != "contract_error" || again.Error.Decoded == nil || again.Error.Decoded.ErrorName != "HandleTaken" {
		t.Fatalf("second claim = %+v / %+v / %+v", again, again.Error, again.Error.Decoded)
	}

	// Reset forgets it.
	deps := defaultDeps()
	deps.ForkRoot = func() (string, error) { return e.root, nil }
	reset := newRootCmdWithDeps("0.0.0-test", "abc1234", deps)
	reset.SetOut(&bytes.Buffer{})
	reset.SetArgs([]string{"sandbox", "session", "reset", "s1"})
	if err := reset.Execute(); err != nil {
		t.Fatal(err)
	}
	after := e.json(registryContract, "resolve", "--arg", "handle=sandbox-test", "--session", "s1")
	if string(after.ReturnValue) != "null" {
		t.Fatalf("resolve after reset = %s", after.ReturnValue)
	}
}

func TestSandboxCallUnknownFunctionListsTheFunctions(t *testing.T) {
	e := newCallEnv(t)
	_, _, err := e.run(registryContract, "frobnicate")
	if code := ExitCode(err); code != exitcode.InvalidInput {
		t.Fatalf("exit %d (%v), want 2", code, err)
	}
	for _, want := range []string{`no function "frobnicate"`, "claim", "count", "resolve"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("message should mention %q: %v", want, err)
		}
	}
	_, _, err = e.run(registryContract, "claim", "--arg", "handle=x", "--arg", "wallet=5")
	if code := ExitCode(err); code != exitcode.InvalidInput || !strings.Contains(err.Error(), "wallet: expected Address") {
		t.Fatalf("bad argument: exit %d (%v)", code, err)
	}
}

func TestSandboxCallJSONMatchesItsSchema(t *testing.T) {
	e := newCallEnv(t)
	schema, err := jsonschema.Load(filepath.Join("..", "..", "..", "sandbox", "protocol", "schema", "v1", "cli-call-result.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{registryContract, "count"},
		{registryContract, "claim", "--arg", "handle=schema-check", "--arg", "wallet=" + testWallet, "--source-account", testWallet},
		{registryContract, "initialize", "--arg", "admin=" + testWallet},
	} {
		stdout, stderr, err := e.run(append(args, "--json")...)
		if err != nil {
			t.Fatalf("%v: %v\n%s", args, err, stderr)
		}
		var v any
		if err := json.Unmarshal([]byte(stdout), &v); err != nil {
			t.Fatalf("%v: not JSON: %s", args, stdout)
		}
		if errs := jsonschema.Validate(schema, schema, v); len(errs) > 0 {
			t.Errorf("%v: %s", args, strings.Join(errs, "\n  "))
		}
	}
}

func TestSandboxCallSourceAccountLeavesTheConfiguredSourceAlone(t *testing.T) {
	e := newCallEnv(t)
	f, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := f.SetConfig("source", "alice"); err != nil {
		t.Fatal(err)
	}
	if err := config.Save(f); err != nil {
		t.Fatal(err)
	}
	res := e.json(registryContract, "count", "--source-account", testWallet)
	if res.SourceAccount != testWallet {
		t.Fatalf("sourceAccount = %q", res.SourceAccount)
	}
	after, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := after.GetConfig("source"); got != "alice" {
		t.Fatalf("config source = %q, want alice", got)
	}
}

func TestFailuresRenderWithTheirOwnWordsAndKeepTheirExitCodes(t *testing.T) {
	res := CallResult{Function: "run", Network: "testnet", ForkLedger: 9, Protocol: 29, ForkTime: time.Unix(1790458600, 0)}
	deps := Deps{Now: func() time.Time { return time.Unix(1790458610, 0) }}

	timeout := renderedFailure(&simulator.TimeoutError{Type: "simulate", Timeout: 10 * time.Second}, res, deps)
	if code := ExitCode(timeout); code != exitcode.Timeout {
		t.Fatalf("timeout exit %d", code)
	}
	for _, want := range []string{"timed out: simulate did not answer within 10s", "may be looping", "ran against testnet · fork ledger 9"} {
		if !strings.Contains(timeout.Error(), want) {
			t.Errorf("timeout lacks %q:\n%s", want, timeout)
		}
	}

	failed := renderedFailure(&simulator.Error{Message: "the simulator exited with status 101"}, res, deps)
	if code := ExitCode(failed); code != exitcode.SimulatorFailure {
		t.Fatalf("simulator failure exit %d", code)
	}
	if !strings.HasPrefix(failed.Error(), "simulator error: ") || !strings.Contains(failed.Error(), "says nothing about the contract") {
		t.Fatalf("simulator failure:\n%s", failed)
	}
	if strings.Contains(failed.Error(), "✗") {
		t.Fatal("a simulator failure must not read as the contract failing")
	}

	plain := &inputError{"bad"}
	if renderedFailure(plain, res, deps) != error(plain) {
		t.Fatal("other errors pass through untouched")
	}
}

func TestSandboxCallAuthModes(t *testing.T) {
	e := newCallEnv(t)
	// The registry's claim asks for the wallet's auth at the root call, so
	// strict mode allows it, and the footer says how auth ran.
	stdout, stderr, err := e.run(registryContract, "claim", "--arg", "handle=strict-check", "--arg", "wallet="+testWallet, "--auth", "strict")
	if err != nil {
		t.Fatalf("%v\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "auth mocked (strict)") || !strings.Contains(stdout, "requires auth from GA5Z…ZVN (claim)") {
		t.Fatalf("stdout:\n%s", stdout)
	}
	res := e.json(registryContract, "count", "--auth", "record")
	if res.AuthMode != "record" {
		t.Fatalf("authMode = %q", res.AuthMode)
	}

	for _, args := range [][]string{
		{registryContract, "count", "--auth", "enforce"},
		{registryContract, "count", "--auth", "sometimes"},
		{registryContract, "count", "--auth-entries", "x.json"},
	} {
		if _, _, err := e.run(args...); ExitCode(err) != exitcode.InvalidInput {
			t.Errorf("%v: exit %d (%v), want 2", args, ExitCode(err), err)
		}
	}

	// enforce with an unsigned entry: checked, and refused.
	claim := e.json(registryContract, "claim", "--arg", "handle=enforce-check", "--arg", "wallet="+testWallet)
	entries, _ := json.Marshal(claim.Auth)
	file := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(file, entries, 0o600); err != nil {
		t.Fatal(err)
	}
	enforced := e.json(registryContract, "claim", "--arg", "handle=enforce-check", "--arg", "wallet="+testWallet, "--auth", "enforce", "--auth-entries", file)
	if enforced.Outcome != "contract_error" || enforced.AuthMode != "enforce" {
		t.Fatalf("enforced = %+v", enforced)
	}
}
