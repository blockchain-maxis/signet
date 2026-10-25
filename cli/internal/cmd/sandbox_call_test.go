package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/fork"
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
		{registryContract, "count", "--advance", "30d", "--unlimited"},
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

func TestSandboxCallMovesTheLedger(t *testing.T) {
	e := newCallEnv(t)
	base := e.json(registryContract, "count")
	if base.Ledger == nil || base.Ledger.Overridden || base.Ledger.Sequence != registryLedger {
		t.Fatalf("ledger = %+v", base.Ledger)
	}

	// A short step: the footer names the new ledger and time; every TTL holds.
	stdout, stderr, err := e.run(registryContract, "count", "--advance", "+100")
	if err != nil {
		t.Fatalf("%v\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "ledger 4887104 (+100)") || !strings.Contains(stdout, "(+8m20s)") || strings.Contains(stdout, "archived") {
		t.Fatalf("stdout:\n%s", stdout)
	}

	// Past the registry's TTL (ledger 4916420): its instance and code are
	// archived, and the call restores them, saying so.
	stdout, stderr, err = e.run(registryContract, "count", "--advance", "30d")
	if err != nil {
		t.Fatalf("%v\n%s", err, stderr)
	}
	for _, want := range []string{"⚠ archived: ", "instance (TTL ran out after ledger 4916420)", "restores it", "(+30d)"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("lacks %q:\n%s", want, stdout)
		}
	}
	far := e.json(registryContract, "count", "--advance", "30d")
	if len(far.Archived) != 2 || far.Archived[0].Outcome != "restored" || string(far.ReturnValue) != string(base.ReturnValue) {
		t.Fatalf("archived = %+v, value %s", far.Archived, far.ReturnValue)
	}

	// A vesting lock 20 days out opens once the clock moves 30 days.
	vesting := filepath.Join("..", "..", "..", "sandbox", "fixtures", "wasm", "vesting.wasm")
	unlock := "--arg=unlock_time=" + strconv.FormatInt(base.ForkTime.Add(20*24*time.Hour).Unix(), 10)
	locked := e.json(registryContract, "is_unlocked", unlock, "--wasm", vesting)
	opened := e.json(registryContract, "is_unlocked", unlock, "--wasm", vesting, "--advance", "30d")
	if string(locked.ReturnValue) != "false" || string(opened.ReturnValue) != "true" {
		t.Fatalf("locked %s, opened %s", locked.ReturnValue, opened.ReturnValue)
	}
	at := e.json(registryContract, "is_unlocked", unlock, "--wasm", vesting,
		"--timestamp", base.ForkTime.Add(21*24*time.Hour).UTC().Format(time.RFC3339))
	if string(at.ReturnValue) != "true" || at.Ledger.Sequence != registryLedger {
		t.Fatalf("--timestamp: %s at %+v", at.ReturnValue, at.Ledger)
	}

	stdout, _, err = e.run(registryContract, "count", "--unlimited")
	if err != nil || !strings.Contains(stdout, "budget unlimited (") {
		t.Fatalf("--unlimited: %v\n%s", err, stdout)
	}

	for _, args := range [][]string{
		{registryContract, "count", "--advance", "30d", "--ledger-seq", "5"},
		{registryContract, "count", "--advance", "soon"},
		{registryContract, "count", "--advance", "+0"},
		{registryContract, "count", "--timestamp", "yesterday"},
		{registryContract, "count", "--ledger-seq", "0"},
		{registryContract, "count", "--budget-instructions", "0"},
	} {
		if _, _, err := e.run(args...); ExitCode(err) != exitcode.InvalidInput {
			t.Errorf("%v: exit %d (%v), want 2", args, ExitCode(err), err)
		}
	}
}

func TestLedgerMoveResolvesAgainstTheFork(t *testing.T) {
	forkTime := time.Unix(1_790_458_607, 0)
	for _, tc := range []struct {
		advance   string
		ledgers   uint32
		timestamp int64
	}{
		{"+100", 4887104, 1_790_458_607 + 500},
		{"30d", 4887004 + 518_400, 1_790_458_607 + 30*86400},
		{"1w1d12h", 4887004 + 146_880, 1_790_458_607 + 8*86400 + 12*3600},
		{"90m", 4887004 + 1080, 1_790_458_607 + 5400},
	} {
		cmd := newSandboxCallCmd()
		m, err := parseLedgerMove(cmd, 0, "", tc.advance)
		if err != nil {
			t.Fatalf("%s: %v", tc.advance, err)
		}
		o := m.at(4887004, forkTime)
		if *o.Sequence != tc.ledgers || int64(*o.Timestamp) != tc.timestamp {
			t.Errorf("%s: ledger %d at %d, want %d at %d", tc.advance, *o.Sequence, *o.Timestamp, tc.ledgers, tc.timestamp)
		}
	}
	if m, _ := parseLedgerMove(newSandboxCallCmd(), 0, "", ""); m.at(1, forkTime) != nil {
		t.Fatal("no flags, no override")
	}
	m, err := parseLedgerMove(newSandboxCallCmd(), 0, "2026-11-24T00:00:00Z", "")
	if err != nil {
		t.Fatal(err)
	}
	if o := m.at(1, forkTime); o.Sequence != nil || *o.Timestamp != 1795478400 {
		t.Fatalf("--timestamp alone: %+v", o)
	}
	for in, want := range map[time.Duration]string{30 * 24 * time.Hour: "+30d", 500 * time.Second: "+8m20s", -36 * time.Hour: "-1d12h0m0s"} {
		if got := span(in); got != want {
			t.Errorf("span(%s) = %q, want %q", in, got, want)
		}
	}
}

// callsFixture is the contract pair of calls-getLedgerEntries.json: the
// caller, the callee, and the callee's instance and code keys.
func callsFixture(t *testing.T) (caller, callee string, calleeKeys [2]string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "rpc", "testdata", "registry", "calls-getLedgerEntries.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Contracts struct{ Caller, Callee string }
		Entries   []struct{ Key string }
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f.Contracts.Caller, f.Contracts.Callee, [2]string{f.Entries[2].Key, f.Entries[3].Key}
}

func TestSandboxCallPullsInWhatItCallsAndPrefetchesItNextTime(t *testing.T) {
	e := newCallEnv(t)
	caller, callee, calleeKeys := callsFixture(t)
	args := []string{caller, "call_add", "--arg", "callee=" + callee, "--arg", "a=2", "--arg", "b=3"}
	batchHolding := func(key string) []int {
		e.rpc.mu.Lock()
		defer e.rpc.mu.Unlock()
		var at []int
		for i, b := range e.rpc.batches {
			for _, k := range b {
				if k == key {
					at = append(at, i)
				}
			}
		}
		return at
	}

	// First run: the callee is fetched when the call reaches it, one key at
	// a time, and said once.
	stdout, stderr, err := e.run(args...)
	if err != nil {
		t.Fatalf("%v\n%s", err, stderr)
	}
	pulled := "+ pulled in " + shorten(callee, 4, 3) + " (contract)"
	if !strings.Contains(stdout, "→ 5") || !strings.Contains(stdout+stderr, pulled) {
		t.Fatalf("stdout:\n%s\nstderr:\n%s", stdout, stderr)
	}
	instanceAt, codeAt := batchHolding(calleeKeys[0]), batchHolding(calleeKeys[1])
	if len(instanceAt) != 1 || len(codeAt) != 1 || instanceAt[0] == codeAt[0] {
		t.Fatalf("lazily: instance in batches %v, code in %v", instanceAt, codeAt)
	}
	forks, err := fork.List(e.root)
	if err != nil || len(forks) != 1 || len(forks[0].Contracts) != 1 || forks[0].Contracts[0] != callee {
		t.Fatalf("manifest contracts = %+v (%v)", forks, err)
	}
	res := e.json(args...)
	if len(res.Contracts) != 1 || res.Contracts[0].ContractID != callee || res.Contracts[0].Executable != "wasm" {
		t.Fatalf("contracts = %+v", res.Contracts)
	}
	if stdout, stderr, _ := e.run(args...); strings.Contains(stdout+stderr, "pulled in") {
		t.Fatalf("said twice:\n%s%s", stdout, stderr)
	}

	// A fresh fork of the same contract: what the call needed comes in one
	// batch before it runs, and nothing about the callee is asked again.
	if err := fork.Remove(forks[0]); err != nil {
		t.Fatal(err)
	}
	before := len(e.rpc.batches)
	if _, stderr, err := e.run(args...); err != nil {
		t.Fatalf("%v\n%s", err, stderr)
	}
	instanceAt, codeAt = batchHolding(calleeKeys[0]), batchHolding(calleeKeys[1])
	last := func(at []int) int { return at[len(at)-1] }
	if last(instanceAt) < before || last(instanceAt) != last(codeAt) {
		t.Fatalf("prefetch: instance in batches %v, code in %v (this run from %d)", instanceAt, codeAt, before)
	}

	// Kept to the caller, the call fails naming the callee.
	_, _, err = e.run(append(args, "--no-related")...)
	if ExitCode(err) != exitcode.InvalidInput || !strings.Contains(err.Error(), callee) {
		t.Fatalf("--no-related: exit %d, %v", ExitCode(err), err)
	}
}
