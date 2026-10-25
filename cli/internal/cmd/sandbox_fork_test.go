package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/fork"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

const (
	registryContract = "CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN"
	registryWasmHash = "936996c74b7d383c56ec174857b15927cdd29478c6909da332b4dec8b67335fe"
	registryLedger   = 4887004
	testnetPhrase    = "Test SDF Network ; September 2015"
)

// The fake's directory is a plain MkdirTemp, removed in TestMain, because
// t.TempDir() would vanish with the first test that asked for it.
var (
	fakeSimOnce sync.Once
	fakeSimDir  string
	fakeSimPath string
	fakeSimErr  error
)

func TestMain(m *testing.M) {
	code := m.Run()
	if fakeSimDir != "" {
		_ = os.RemoveAll(fakeSimDir)
	}
	os.Exit(code)
}

// buildFakeSimulator compiles internal/simulator's fake once per run; its
// FAKESIM_SCRIPT mode plays the simulator's side of a fork.
func buildFakeSimulator(t *testing.T) string {
	t.Helper()
	fakeSimOnce.Do(func() {
		dir, err := os.MkdirTemp("", "fakesim-cmd")
		if err != nil {
			fakeSimErr = err
			return
		}
		fakeSimDir = dir
		out := filepath.Join(dir, "signet-simulator")
		if runtime.GOOS == "windows" {
			out += ".exe"
		}
		build := exec.Command("go", "build", "-o", out, "../simulator/testdata/fakesimulator")
		if output, err := build.CombinedOutput(); err != nil {
			fakeSimErr = fmt.Errorf("%w: %s", err, output)
			return
		}
		fakeSimPath = out
	})
	if fakeSimErr != nil {
		t.Skipf("could not build the fake simulator: %v", fakeSimErr)
	}
	return fakeSimPath
}

// registryRPC serves internal/rpc/testdata/registry: each method from the
// file of its name, getLedgerEntries narrowed to the keys asked for.
type registryRPC struct {
	t        *testing.T
	srv      *httptest.Server
	mu       sync.Mutex
	asked    []string
	override map[string]any // method -> result, replacing the fixture
	// latest, when set, answers getLatestLedger in turn (the last repeats).
	latest []map[string]any
}

func newRegistryRPC(t *testing.T) *registryRPC {
	r := &registryRPC{t: t, override: map[string]any{}}
	r.srv = httptest.NewServer(http.HandlerFunc(r.serve))
	t.Cleanup(r.srv.Close)
	return r
}

func (r *registryRPC) fixture(method string) map[string]any {
	raw, err := os.ReadFile(filepath.Join("..", "rpc", "testdata", "registry", method+".json"))
	if err != nil {
		r.t.Fatalf("fixture %s: %v", method, err)
	}
	var v map[string]any
	if err := json.Unmarshal(raw, &v); err != nil {
		r.t.Fatal(err)
	}
	return v
}

func (r *registryRPC) serve(w http.ResponseWriter, req *http.Request) {
	var call struct {
		ID     any             `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	_ = json.NewDecoder(req.Body).Decode(&call)
	r.mu.Lock()
	result, ok := r.override[call.Method]
	if call.Method == "getLatestLedger" && len(r.latest) > 0 {
		result, ok = r.latest[0], true
		if len(r.latest) > 1 {
			r.latest = r.latest[1:]
		}
	}
	r.mu.Unlock()
	if !ok {
		fixture := r.fixture(call.Method)
		if call.Method == "getLedgerEntries" {
			var params struct{ Keys []string }
			_ = json.Unmarshal(call.Params, &params)
			r.mu.Lock()
			r.asked = append(r.asked, params.Keys...)
			r.mu.Unlock()
			want := map[string]bool{}
			for _, k := range params.Keys {
				want[k] = true
			}
			var picked []any
			for _, e := range fixture["entries"].([]any) {
				if want[e.(map[string]any)["key"].(string)] {
					picked = append(picked, e)
				}
			}
			fixture["entries"] = picked
		}
		result = fixture
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": call.ID, "result": result})
}

// recordedKeys are the fixture's keys: instance, code, then the ten config
// settings.
func (r *registryRPC) recordedKeys() []string {
	var keys []string
	for _, e := range r.fixture("getLedgerEntries")["entries"].([]any) {
		keys = append(keys, e.(map[string]any)["key"].(string))
	}
	return keys
}

// forkScript is what the fake simulator does for a fork of the registry:
// fetch the config on ledger_open, the instance and code on contract_info.
func (r *registryRPC) forkScript(t *testing.T, info map[string]any) string {
	keys := r.recordedKeys()
	script := map[string]any{
		"ledger_open": map[string]any{
			"fetch": keys[2:],
			"reply": map[string]any{"ledger_protocol": 28, "sequence": registryLedger},
		},
		"contract_info": map[string]any{"fetch": keys[:2], "reply": info},
	}
	path := filepath.Join(t.TempDir(), "script.json")
	raw, _ := json.Marshal(script)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func registryInfo() map[string]any {
	return map[string]any{
		"contract_id": registryContract, "executable": "wasm", "wasm_hash": registryWasmHash,
		"storage_entries": 3, "misses": []any{},
	}
}

type forkRun struct {
	stdout, stderr *bytes.Buffer
	err            error
	root           string
}

// runFork runs `signet sandbox fork` against the fixture RPC and the fake
// simulator.
func runFork(t *testing.T, r *registryRPC, script string, args ...string) forkRun {
	t.Helper()
	isolateConfigDir(t)
	root := t.TempDir()
	sim := buildFakeSimulator(t)
	deps := defaultDeps()
	deps.KeysBinary = "/nonexistent/signet-test-stellar"
	deps.ForkRoot = func() (string, error) { return root, nil }
	deps.LocateSimulator = func(context.Context, string, func(string)) (string, error) { return sim, nil }
	deps.SimulatorOptions = []simulator.Option{simulator.WithEnv("FAKESIM_SCRIPT=" + script)}
	deps.Now = func() time.Time { return time.Unix(1790458610, 0) }

	cmd := newRootCmdWithDeps("0.0.0-test", "abc1234", deps)
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	cmd.SetOut(stdout)
	cmd.SetErr(stderr)
	cmd.SetIn(strings.NewReader(""))
	cmd.SetArgs(append([]string{"sandbox", "fork", "--rpc-url", r.srv.URL}, args...))
	return forkRun{stdout: stdout, stderr: stderr, err: cmd.Execute(), root: root}
}

func TestSandboxForkPinsTheRegistry(t *testing.T) {
	r := newRegistryRPC(t)
	run := runFork(t, r, r.forkScript(t, registryInfo()), registryContract)
	if run.err != nil {
		t.Fatalf("fork: %v\nstderr: %s", run.err, run.stderr)
	}
	// The fixture's config entries were recorded later than the registry's
	// ledger, so seven of them drifted (#551).
	want := driftWarning + "\n" +
		"Forked CASF…RCN on testnet at ledger 4887004 (protocol 28, 3s ago) · wasm 9369…fe · instance storage 3 entries\n"
	if run.stdout.String() != want {
		t.Fatalf("stdout:\n got %q\nwant %q", run.stdout, want)
	}

	id := fork.ID(registryContract, registryLedger)
	m, err := fork.ReadManifest(fork.Dir(run.root, testnetPhrase, id))
	if err != nil {
		t.Fatal(err)
	}
	if m.Network != "testnet" || m.Passphrase != testnetPhrase || m.RPCURL != r.srv.URL ||
		m.Contract != registryContract || m.ForkLedger != registryLedger || m.Protocol != 28 ||
		m.WasmHash != registryWasmHash || m.Executable != "wasm" || m.InstanceStorageEntries != 3 ||
		m.ForkTime.Unix() != 1790458607 {
		t.Fatalf("manifest = %+v", m)
	}

	// Everything the simulator fetched is in the cache now.
	cache, err := fork.Open(run.root, testnetPhrase, id)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cache.Close() }()
	found, _, err := cache.Lookup(r.recordedKeys())
	if err != nil || len(found) != 12 {
		t.Fatalf("cached %d of 12 entries (%v)", len(found), err)
	}
}

func TestSandboxForkJSONIsTheManifest(t *testing.T) {
	r := newRegistryRPC(t)
	run := runFork(t, r, r.forkScript(t, registryInfo()), registryContract, "--json")
	if run.err != nil {
		t.Fatalf("fork: %v\nstderr: %s", run.err, run.stderr)
	}
	var m fork.Manifest
	if err := json.Unmarshal(run.stdout.Bytes(), &m); err != nil {
		t.Fatalf("stdout is not a manifest: %v\n%s", err, run.stdout)
	}
	if m.Contract != registryContract || m.WasmHash != registryWasmHash || m.ForkLedger != registryLedger {
		t.Fatalf("manifest = %+v", m)
	}
}

func TestSandboxForkRefusesAnAccountAddress(t *testing.T) {
	r := newRegistryRPC(t)
	run := runFork(t, r, "", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")
	if code := ExitCode(run.err); code != exitcode.InvalidInput {
		t.Fatalf("exit %d (%v), want 2", code, run.err)
	}
	if !strings.Contains(run.err.Error(), "is an account address, not a contract") {
		t.Fatalf("message: %v", run.err)
	}
	if run.err != nil && strings.Contains(run.err.Error(), "RPC") {
		t.Fatalf("the network was consulted for an account address: %v", run.err)
	}
	for _, bad := range []string{"not-an-address", "CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCM"} {
		if code := ExitCode(runFork(t, r, "", bad).err); code != exitcode.InvalidInput {
			t.Errorf("%s: exit %d, want 2", bad, code)
		}
	}
}

func TestSandboxForkOfAMissingContractExits2AndKeepsNothing(t *testing.T) {
	r := newRegistryRPC(t)
	keys := r.recordedKeys()
	script := map[string]any{
		"ledger_open":   map[string]any{"fetch": keys[2:], "reply": map[string]any{"ledger_protocol": 28, "sequence": registryLedger}},
		"contract_info": map[string]any{"fetch": keys[:1], "reply": map[string]any{"type": "error", "code": "bad_request", "message": "there is no contract in this ledger", "detail": map[string]any{"kind": "invalid_field", "path": "contract_id"}}},
	}
	path := filepath.Join(t.TempDir(), "script.json")
	raw, _ := json.Marshal(script)
	_ = os.WriteFile(path, raw, 0o600)

	run := runFork(t, r, path, registryContract)
	if code := ExitCode(run.err); code != exitcode.InvalidInput {
		t.Fatalf("exit %d (%v), want 2", code, run.err)
	}
	if !strings.Contains(run.err.Error(), "no contract "+registryContract+" on testnet at ledger 4887004") {
		t.Fatalf("message: %v", run.err)
	}
	if _, err := os.Stat(fork.Dir(run.root, testnetPhrase, fork.ID(registryContract, registryLedger))); !os.IsNotExist(err) {
		t.Fatalf("a fork of a missing contract was kept: %v", err)
	}
}

func TestSandboxForkRefusesANetworkAheadOfTheSimulator(t *testing.T) {
	r := newRegistryRPC(t)
	latest := r.fixture("getLatestLedger")
	latest["protocolVersion"] = 29
	r.override["getLatestLedger"] = latest
	run := runFork(t, r, r.forkScript(t, registryInfo()), registryContract)
	if code := ExitCode(run.err); code != exitcode.HostUnsupported {
		t.Fatalf("exit %d (%v), want 11", code, run.err)
	}
	if !strings.Contains(run.err.Error(), "testnet runs ledger protocol 29") {
		t.Fatalf("message: %v", run.err)
	}
}

func TestSandboxForkRefusesAnRPCOnAnotherNetwork(t *testing.T) {
	r := newRegistryRPC(t)
	r.override["getNetwork"] = map[string]any{"passphrase": "Public Global Stellar Network ; September 2015", "protocolVersion": 28}
	run := runFork(t, r, r.forkScript(t, registryInfo()), registryContract)
	if code := ExitCode(run.err); code != exitcode.Configuration {
		t.Fatalf("exit %d (%v), want 3", code, run.err)
	}
}

func TestDescribeFork(t *testing.T) {
	m := fork.Manifest{Contract: registryContract, Network: "mainnet", ForkLedger: 9, Protocol: 28,
		ForkTime: time.Unix(1000, 0), Executable: "stellar_asset", InstanceStorageEntries: 1}
	got := describeFork(m, time.Unix(1000+7200, 0))
	want := "Forked CASF…RCN on mainnet at ledger 9 (protocol 28, 2h ago) · Stellar Asset Contract · instance storage 1 entry"
	if got != want {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
}

const driftWarning = "⚠ 7 entries changed on-chain after the fork ledger; results mix ledger 4887004 and 5370048"

func TestSandboxForkDriftModes(t *testing.T) {
	t.Run("warn", func(t *testing.T) {
		r := newRegistryRPC(t)
		run := runFork(t, r, r.forkScript(t, registryInfo()), registryContract, "--json")
		if run.err != nil {
			t.Fatalf("fork: %v", run.err)
		}
		if !strings.Contains(run.stderr.String(), driftWarning) {
			t.Fatalf("stderr = %q", run.stderr)
		}
		var m fork.Manifest
		_ = json.Unmarshal(run.stdout.Bytes(), &m)
		if m.DriftedEntries != 7 {
			t.Fatalf("driftedEntries = %d", m.DriftedEntries)
		}
	})

	t.Run("fail", func(t *testing.T) {
		r := newRegistryRPC(t)
		run := runFork(t, r, r.forkScript(t, registryInfo()), registryContract, "--drift", "fail")
		if code := ExitCode(run.err); code != exitcode.Network {
			t.Fatalf("exit %d (%v), want 6", code, run.err)
		}
		if !strings.Contains(run.err.Error(), driftWarning) {
			t.Fatalf("message: %v", run.err)
		}
	})

	t.Run("refork", func(t *testing.T) {
		r := newRegistryRPC(t)
		first := r.fixture("getLatestLedger")
		newer := r.fixture("getLatestLedger")
		newer["sequence"] = 5370090
		r.latest = []map[string]any{first, newer}
		run := runFork(t, r, r.forkScript(t, registryInfo()), registryContract, "--drift", "refork", "--json")
		if run.err != nil {
			t.Fatalf("fork: %v\nstderr: %s", run.err, run.stderr)
		}
		var m fork.Manifest
		_ = json.Unmarshal(run.stdout.Bytes(), &m)
		if m.ForkLedger != 5370090 || m.DriftedEntries != 0 {
			t.Fatalf("re-pinned manifest = %+v", m)
		}
		if !strings.Contains(run.stderr.String(), "forking again at the latest ledger") {
			t.Fatalf("stderr = %q", run.stderr)
		}
	})

	t.Run("bad mode", func(t *testing.T) {
		r := newRegistryRPC(t)
		run := runFork(t, r, "", registryContract, "--drift", "sometimes")
		if code := ExitCode(run.err); code != exitcode.InvalidInput {
			t.Fatalf("exit %d (%v), want 2", code, run.err)
		}
	})
}
