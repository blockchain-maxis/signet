package dev

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/devconfig"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// realSimulator is the debug build cargo leaves in sandbox/target, or
// SIGNET_SIMULATOR_PATH; the test is skipped without one, as the CI
// sandbox job builds it.
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

func fixtureWasm(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "sandbox", "fixtures", "wasm", name+".wasm"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// networkConfig is testnet's recorded ConfigSetting entries, which every
// open ledger needs.
func networkConfig(t *testing.T) []simulator.PutEntry {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "sandbox", "simulator", "tests", "fixtures", "network-config-entries.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Payload struct {
			Entries []struct {
				Key          string `json:"key"`
				XDR          string `json:"xdr"`
				LastModified uint32 `json:"lastModifiedLedgerSeq"`
			} `json:"entries"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	out := make([]simulator.PutEntry, len(f.Payload.Entries))
	for i, e := range f.Payload.Entries {
		out[i] = simulator.PutEntry{KeyXDR: e.Key, DataXDR: e.XDR, LastModifiedLedgerSeq: &e.LastModified}
	}
	return out
}

// countingHost counts the requests a cycle makes, by type.
type countingHost struct {
	*simulator.Client
	mu    sync.Mutex
	calls map[string]int
}

func (h *countingHost) Call(ctx context.Context, typ string, params, result any) (*simulator.ContractError, error) {
	h.mu.Lock()
	h.calls[typ]++
	h.mu.Unlock()
	return h.Client.Call(ctx, typ, params, result)
}

func (h *countingHost) take(typ string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := h.calls[typ]
	h.calls = map[string]int{}
	return n
}

// session opens a ledger with counter_v1 installed as the "deployed"
// contract, its count unset, and returns the host and the contract's id.
func session(t *testing.T, opts ...simulator.Option) (*countingHost, string) {
	t.Helper()
	ctx := context.Background()
	c, err := simulator.Start(ctx, realSimulator(t), opts...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	// Nothing beyond what the test puts in: whatever a call reads that is
	// not in the ledger (an auth nonce) is absent.
	c.HandleFetch(func(keys []string) ([]simulator.Entry, error) {
		out := make([]simulator.Entry, len(keys))
		for i, k := range keys {
			out[i] = simulator.Absent(k)
		}
		return out, nil
	})
	host := &countingHost{Client: c, calls: map[string]int{}}
	protocol, seq := 28, uint32(100)
	if err := call(ctx, host, simulator.TypeLedgerOpen, simulator.LedgerOpenParams{
		NetworkPassphrase: "Test SDF Network ; September 2015", LedgerProtocol: &protocol, Sequence: &seq,
		Entries: networkConfig(t),
	}, nil); err != nil {
		t.Fatal(err)
	}
	var installed simulator.ContractInstallResult
	if err := call(ctx, host, simulator.TypeContractInstall, simulator.ContractInstallParams{
		WasmBase64: base64.StdEncoding.EncodeToString(fixtureWasm(t, "counter_v1")),
	}, &installed); err != nil {
		t.Fatal(err)
	}
	host.take("")
	return host, installed.ContractID
}

func replays() []Replay {
	return []Replay{
		{Name: "get", Params: simulator.SimulateParams{Function: "get", Args: map[string]any{}}},
		{Name: "increment", Params: simulator.SimulateParams{Function: "increment", Args: map[string]any{}}},
	}
}

func returned(t *testing.T, r Run) string {
	t.Helper()
	if r.Result == nil {
		t.Fatalf("no result: %+v", r.Error)
	}
	return string(r.Result.ReturnValue)
}

// The acceptance test of #566: cycle 1 runs A and B, cycle 2 after an edit
// that leaves the build as it was runs only B, and base is the same after
// both.
func TestReloadCycleRunsAOnceAndLeavesBaseAlone(t *testing.T) {
	ctx := context.Background()
	host, contract := session(t)
	r, err := NewReloader(ctx, host, contract)
	if err != nil {
		t.Fatal(err)
	}
	v2 := fixtureWasm(t, "counter_v2_event")

	first, err := r.Cycle(ctx, v2, replays())
	if err != nil {
		t.Fatal(err)
	}
	if n := host.take(simulator.TypeSimulate); n != 4 || first.Simulations != 4 {
		t.Fatalf("cycle 1: %d simulations in the host (reported %d), want 4", n, first.Simulations)
	}
	if first.Deployed == first.Local {
		t.Fatal("v2 was not swapped in")
	}
	inc := first.Outcomes[1]
	if returned(t, inc.A) != "1" || returned(t, inc.B) != "1" {
		t.Fatalf("increment from base: A %s, B %s", returned(t, inc.A), returned(t, inc.B))
	}
	if len(inc.A.Result.Events) != 0 || len(inc.B.Result.Events) != 1 {
		t.Fatalf("only v2 emits Incremented: A %d events, B %d", len(inc.A.Result.Events), len(inc.B.Result.Events))
	}
	if inc.A.Result.Seed != inc.B.Result.Seed {
		t.Fatalf("A and B drew different seeds: %s, %s", inc.A.Result.Seed, inc.B.Result.Seed)
	}
	// The diff (#568): get returns the same, and only costs differ (v2 is a
	// bigger module to load); increment gained an event.
	if d := first.Outcomes[0].Diff; d == nil || d.Outcome != nil || d.ReturnValue != nil || len(d.Events.Added)+len(d.Storage.Changed) != 0 || len(d.Resources) == 0 {
		t.Fatalf("get's diff: %+v", d)
	}
	if d := inc.Diff; d == nil || d.Empty || len(d.Events.Added) != 1 || d.ReturnValue != nil || len(d.Storage.Changed) != 0 {
		t.Fatalf("increment's diff: %+v", d)
	}

	// An unrelated edit: the same bytes again.
	second, err := r.Cycle(ctx, v2, replays())
	if err != nil {
		t.Fatal(err)
	}
	if n := host.take(simulator.TypeSimulate); n != 2 || second.Simulations != 2 {
		t.Fatalf("cycle 2: %d simulations in the host (reported %d), want B's 2", n, second.Simulations)
	}
	if host.take(simulator.TypeContractInstall) != 0 {
		t.Fatal("the same build was installed twice")
	}
	for _, o := range second.Outcomes {
		if !o.A.Cached || o.B.Cached {
			t.Fatalf("%s: A cached %v, B cached %v", o.Name, o.A.Cached, o.B.Cached)
		}
	}
	if returned(t, second.Outcomes[1].B) != "1" {
		t.Fatalf("cycle 2's increment did not start from base: %s", returned(t, second.Outcomes[1].B))
	}

	// Base is untouched: the deployed executable, and storage as it was.
	var info simulator.ContractInfoResult
	if err := call(ctx, host, simulator.TypeContractInfo, simulator.ContractInfoParams{ContractID: contract}, &info); err != nil {
		t.Fatal(err)
	}
	if *info.WasmHash != r.Deployed() || info.StorageEntries != 0 {
		t.Fatalf("base after two cycles: executable %s (deployed %s), %d storage entries", *info.WasmHash, r.Deployed(), info.StorageEntries)
	}
	var get simulator.SimulateResult
	if ce, err := host.Call(ctx, simulator.TypeSimulate, simulator.SimulateParams{ContractID: contract, Function: "get", Args: map[string]any{}}, &get); err != nil || ce != nil {
		t.Fatalf("get: %v %v", ce, err)
	}
	if string(get.ReturnValue) != "0" {
		t.Fatalf("count at base = %s, want 0", get.ReturnValue)
	}
}

// After the idle stop the respawn replays the session, the cycle's results
// are what they would have been, and the cycle says it restarted.
func TestReloadCycleSaysTheSimulatorRestarted(t *testing.T) {
	ctx := context.Background()
	host, contract := session(t, simulator.WithIdleTimeout(50*time.Millisecond))
	r, err := NewReloader(ctx, host, contract)
	if err != nil {
		t.Fatal(err)
	}
	v2 := fixtureWasm(t, "counter_v2_event")
	first, err := r.Cycle(ctx, v2, replays())
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Restarted) != 0 {
		t.Fatalf("cycle 1 restarted: %v", first.Restarted)
	}
	time.Sleep(300 * time.Millisecond)
	second, err := r.Cycle(ctx, v2, replays())
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Restarted) != 1 || second.Restarted[0] != simulator.RestartIdle {
		t.Fatalf("restarted = %v, want [idle]", second.Restarted)
	}
	b := second.Outcomes[1].B
	if returned(t, b) != "1" || len(b.Result.Events) != 1 {
		t.Fatalf("increment on v2 after the respawn: %s, %d events", returned(t, b), len(b.Result.Events))
	}
}

func TestRulesOfReadsTolerancesAsPercentOrAmount(t *testing.T) {
	rules, err := RulesOf(devconfig.Diff{
		IgnoreEvents:      []string{"incremented"},
		ResourceTolerance: map[string]string{"instructions": "10%", "fee": "500"},
	}, "CABC")
	if err != nil {
		t.Fatal(err)
	}
	if p := rules.ResourceTolerance["instructions"].Percent; p == nil || *p != 10 {
		t.Fatalf("instructions: %+v", rules.ResourceTolerance["instructions"])
	}
	if a := rules.ResourceTolerance["resource_fee"].Absolute; a == nil || *a != 500 {
		t.Fatalf("fee is the resource fee: %+v", rules.ResourceTolerance)
	}
	if rules.ContractID != "CABC" || rules.IgnoreEvents[0] != "incremented" {
		t.Fatalf("%+v", rules)
	}
}

// With [diff] rules (#569) an event and cost moves the build is allowed to
// make leave the call clean, still counted as ignored.
func TestReloadCycleDiffsUnderTheRules(t *testing.T) {
	ctx := context.Background()
	host, contract := session(t)
	r, err := NewReloader(ctx, host, contract)
	if err != nil {
		t.Fatal(err)
	}
	rules, err := RulesOf(devconfig.Diff{
		IgnoreEvents:      []string{"incremented"},
		ResourceTolerance: map[string]string{"instructions": "50%", "mem_bytes": "50%", "fee": "50%", "write_bytes": "50%", "read_bytes": "50%"},
	}, contract)
	if err != nil {
		t.Fatal(err)
	}
	r.SetRules(rules)
	cycle, err := r.Cycle(ctx, fixtureWasm(t, "counter_v2_event"), replays())
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range cycle.Outcomes {
		if o.Diff == nil || !o.Diff.Summary.Clean() {
			t.Fatalf("%s: %+v", o.Name, o.Diff)
		}
	}
	if inc := cycle.Outcomes[1].Diff; inc.Summary.Ignored == 0 || inc.Events.Added[0].Class != simulator.ClassIgnored {
		t.Fatalf("the ignored event is still listed: %+v", inc)
	}
}

func expect(t *testing.T, text string) devconfig.Expect {
	t.Helper()
	var e devconfig.Expect
	if err := e.UnmarshalText([]byte(text)); err != nil {
		t.Fatal(err)
	}
	return e
}

// #567: unchanged passes when the build is the deployed WASM and fails on
// counter_v2_return, whose increment returns an i128.
func TestExpectUnchangedHoldsOnlyForTheSameBehaviour(t *testing.T) {
	ctx := context.Background()
	calls := func() []Replay {
		r := replays()
		for i := range r {
			r[i].Expect = expect(t, "unchanged")
		}
		return r
	}
	for _, tc := range []struct {
		build string
		pass  bool
	}{{"counter_v1", true}, {"counter_v2_return", false}} {
		host, contract := session(t)
		r, err := NewReloader(ctx, host, contract)
		if err != nil {
			t.Fatal(err)
		}
		cycle, err := r.Cycle(ctx, fixtureWasm(t, tc.build), calls())
		if err != nil {
			t.Fatal(err)
		}
		v := cycle.Outcomes[1].Verdict
		if v == nil || v.Pass != tc.pass || v.Expect != "unchanged" {
			t.Fatalf("%s: increment's verdict %+v, want pass %v", tc.build, v, tc.pass)
		}
		if !tc.pass && !strings.Contains(v.Reason, "A and B differ: 2 breaking") {
			t.Fatalf("%s: reason %q", tc.build, v.Reason)
		}
	}
}

const (
	admin  = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
	wallet = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
)

// #567: error:HandleTaken passes when B returns it; ok and a wrong name
// fail, and say what B did.
func TestExpectErrorNamesTheContractError(t *testing.T) {
	ctx := context.Background()
	host, _ := session(t)
	registry, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "spec", "fixtures", "identity-registry.wasm"))
	if err != nil {
		t.Fatal(err)
	}
	var installed simulator.ContractInstallResult
	if err := call(ctx, host, simulator.TypeContractInstall, simulator.ContractInstallParams{WasmBase64: base64.StdEncoding.EncodeToString(registry)}, &installed); err != nil {
		t.Fatal(err)
	}
	// Set up before base, at call indices the replays do not use: the same
	// index is the same seed, and so the same auth nonce.
	for i, step := range []struct {
		fn   string
		args map[string]any
	}{{"initialize", map[string]any{"admin": admin}}, {"claim", map[string]any{"handle": "alice", "wallet": wallet}}} {
		index := uint64(100 + i)
		if ce, err := host.Call(ctx, simulator.TypeSimulate, simulator.SimulateParams{ContractID: installed.ContractID, Function: step.fn, Args: step.args, CallIndex: &index}, nil); err != nil || ce != nil {
			t.Fatalf("%s: %v %v", step.fn, ce, err)
		}
	}
	r, err := NewReloader(ctx, host, installed.ContractID)
	if err != nil {
		t.Fatal(err)
	}
	claim := simulator.SimulateParams{Function: "claim", Args: map[string]any{"handle": "alice", "wallet": wallet}}
	cycle, err := r.Cycle(ctx, registry, []Replay{
		{Name: "taken", Params: claim, Expect: expect(t, "error:HandleTaken")},
		{Name: "taken, expected ok", Params: claim, Expect: expect(t, "ok")},
		{Name: "taken, another error", Params: claim, Expect: expect(t, "error:NotOwner")},
		{Name: "anything", Params: claim, Expect: expect(t, "any")},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		pass   bool
		reason string
	}{{true, ""}, {false, "it failed with HandleTaken"}, {false, "it failed with HandleTaken, not NotOwner"}, {true, ""}}
	for i, w := range want {
		v := cycle.Outcomes[i].Verdict
		if v == nil || v.Pass != w.pass || v.Reason != w.reason {
			t.Errorf("%s: %+v, want pass %v %q", cycle.Outcomes[i].Name, v, w.pass, w.reason)
		}
	}
}

// #567: a chained call starts from the previous call's end state, on both
// sides; an unchained one from base.
func TestAChainedCallSeesThePreviousWrite(t *testing.T) {
	ctx := context.Background()
	host, contract := session(t)
	r, err := NewReloader(ctx, host, contract)
	if err != nil {
		t.Fatal(err)
	}
	whatever := expect(t, "any")
	get := simulator.SimulateParams{Function: "get", Args: map[string]any{}}
	cycle, err := r.Cycle(ctx, fixtureWasm(t, "counter_v2_event"), []Replay{
		{Name: "increment", Params: simulator.SimulateParams{Function: "increment", Args: map[string]any{}}, Expect: whatever},
		{Name: "get after it", Params: get, Chain: true, Expect: whatever},
		{Name: "get from base", Params: get, Expect: whatever},
	})
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range []string{"1", "1", "0"} {
		o := cycle.Outcomes[i]
		if returned(t, o.A) != want || returned(t, o.B) != want {
			t.Errorf("%s: A %s, B %s, want %s", o.Name, returned(t, o.A), returned(t, o.B), want)
		}
	}
	// The chain is cached as a whole: a second cycle reuses all of A.
	again, err := r.Cycle(ctx, fixtureWasm(t, "counter_v2_event"), []Replay{
		{Name: "increment", Params: simulator.SimulateParams{Function: "increment", Args: map[string]any{}}, Expect: whatever},
		{Name: "get after it", Params: get, Chain: true, Expect: whatever},
	})
	if err != nil {
		t.Fatal(err)
	}
	if again.Simulations != 2 || !again.Outcomes[1].A.Cached || returned(t, again.Outcomes[1].B) != "1" {
		t.Fatalf("second cycle: %d runs, %+v", again.Simulations, again.Outcomes[1])
	}
}
