package simulator

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

const registry = "CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN"

func start(t *testing.T, opts ...Option) *Client {
	t.Helper()
	c, err := Start(context.Background(), buildFake(t), opts...)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func startTranscript(t *testing.T, name string, opts ...Option) *Client {
	t.Helper()
	return start(t, append(opts, WithEnv("FAKESIM_TRANSCRIPT="+transcript(name)))...)
}

// fakeLog is a FAKESIM_LOG file: one "<pid> <line>" per line the fake read.
type fakeLog string

func newFakeLog(t *testing.T) (fakeLog, Option) {
	path := filepath.Join(t.TempDir(), "fake.log")
	return fakeLog(path), WithEnv("FAKESIM_LOG=" + path)
}

// byProcess groups the logged lines by process, in spawn order.
func (l fakeLog) byProcess(t *testing.T) [][]string {
	t.Helper()
	raw, err := os.ReadFile(string(l))
	if err != nil {
		t.Fatalf("read fake log: %v", err)
	}
	var order []string
	groups := map[string][]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		pid, rest, _ := strings.Cut(line, " ")
		if _, seen := groups[pid]; !seen {
			order = append(order, pid)
		}
		groups[pid] = append(groups[pid], rest)
	}
	out := make([][]string, len(order))
	for i, pid := range order {
		out[i] = groups[pid]
	}
	return out
}

func types(lines []string) []string {
	var out []string
	for _, l := range lines {
		if l == "SIGTERM" {
			out = append(out, l)
			continue
		}
		_, after, _ := strings.Cut(l, `"type":"`)
		typ, _, _ := strings.Cut(after, `"`)
		out = append(out, typ)
	}
	return out
}

func TestStartRejectsAProtocolVersionMismatch(t *testing.T) {
	ack := `{"version":1,"id":"hello","type":"hello_ack","server_protocol_version":2,"simulator_version":"9.9.9","commit":"x","lanes":[]}`
	_, err := Start(context.Background(), buildFake(t), WithEnv("FAKESIM_FIRST_LINE="+ack))
	want := "simulator protocol version mismatch: CLI expects 1, found binary reporting 2 — reinstall signet-cli so both binaries come from the same release."
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
	if !errors.Is(err, exitcode.ErrSimulator) {
		t.Fatalf("a mismatch should be a simulator failure: %v", err)
	}
}

func TestStartRejectsAnythingButAHelloAck(t *testing.T) {
	const want = "could not start the contract simulator — reinstall signet-cli."
	cases := map[string][]string{
		"garbage first line": {"FAKESIM_FIRST_LINE=this is not json"},
		"wrong type":         {`FAKESIM_FIRST_LINE={"version":1,"id":"hello","type":"result"}`},
		"exit before ack":    {"FAKESIM_EXIT_EARLY=1"},
	}
	for name, env := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := Start(context.Background(), buildFake(t), WithEnv(env...))
			if err == nil || err.Error() != want {
				t.Fatalf("err = %v, want %q", err, want)
			}
			if !errors.Is(err, exitcode.ErrSimulator) {
				t.Fatalf("should be a simulator failure: %v", err)
			}
		})
	}

	t.Run("missing binary", func(t *testing.T) {
		_, err := Start(context.Background(), filepath.Join(t.TempDir(), "nope"))
		if err == nil || err.Error() != want {
			t.Fatalf("err = %v, want %q", err, want)
		}
	})
}

func TestTranscriptSimulate(t *testing.T) {
	c := startTranscript(t, "simulate")
	ctx := context.Background()

	var opened LedgerOpenResult
	if _, err := c.Call(ctx, TypeLedgerOpen, LedgerOpenParams{NetworkPassphrase: "Test SDF Network ; September 2015"}, &opened); err != nil {
		t.Fatalf("ledger_open: %v", err)
	}
	if opened.LedgerProtocol != 28 || opened.Sequence != 1 {
		t.Fatalf("ledger_open = %+v", opened)
	}
	var installed ContractInstallResult
	if _, err := c.Call(ctx, TypeContractInstall, ContractInstallParams{WasmBase64: "AGFzbQEAAAA=", ContractID: registry}, &installed); err != nil {
		t.Fatalf("contract_install: %v", err)
	}
	var res SimulateResult
	ce, err := c.Call(ctx, TypeSimulate, SimulateParams{ContractID: registry, Function: "count", Args: []any{}}, &res)
	if err != nil || ce != nil {
		t.Fatalf("simulate: ce=%v err=%v", ce, err)
	}
	if res.ReturnValueXDR != "AAAAAwAAAAE=" || res.Cost.CPUInsns != 1234 {
		t.Fatalf("simulate = %+v", res)
	}
	if ack := c.HelloAck(); ack.Commit != "fake" || len(ack.Lanes) != 1 || ack.Lanes[0].LedgerProtocol != 28 {
		t.Fatalf("hello_ack = %+v", ack)
	}
}

func TestContractErrorIsAValueNotAGoError(t *testing.T) {
	c := startTranscript(t, "contract_error")
	ctx := context.Background()

	ce, err := c.Call(ctx, TypeSimulate, SimulateParams{
		ContractID: registry, Function: "claim",
		Args: []any{"alice", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"},
	}, nil)
	if err != nil {
		t.Fatalf("a contract_error must not be a Go error: %v", err)
	}
	if ce == nil || ce.Kind != "contract" || ce.Decoded == nil || ce.Decoded.ErrorName != "HandleTaken" {
		t.Fatalf("contract_error = %+v", ce)
	}

	ce, err = c.Call(ctx, TypeSimulate, SimulateParams{ContractID: registry, Function: "loop_forever", Args: []any{}}, nil)
	if err != nil || ce == nil || ce.Kind != "host" || ce.Code != "Error(Budget, ExceededLimit)" {
		t.Fatalf("host error: ce=%+v err=%v", ce, err)
	}
}

func TestNestedLedgerFetchDuringSimulate(t *testing.T) {
	c := startTranscript(t, "ledger_fetch")
	ctx := context.Background()

	var asked []string
	c.HandleFetch(func(keys []string) ([]Entry, error) {
		asked = keys
		entry := "AAAAAAAAAABBBBBBBBBBBBBBBBBBBB=="
		live := uint32(1000)
		return []Entry{{KeyXDR: keys[0], EntryXDR: &entry, LiveUntilLedger: &live}}, nil
	})
	if _, err := c.Call(ctx, TypeLedgerOpen, LedgerOpenParams{NetworkPassphrase: "Test SDF Network ; September 2015"}, nil); err != nil {
		t.Fatalf("ledger_open: %v", err)
	}
	var res SimulateResult
	ce, err := c.Call(ctx, TypeSimulate, SimulateParams{ContractID: registry, Function: "lookup", Args: []any{"alice"}}, &res)
	if err != nil || ce != nil {
		t.Fatalf("simulate: ce=%v err=%v", ce, err)
	}
	if len(asked) != 1 || asked[0] != "AAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" {
		t.Fatalf("fetch handler asked for %v", asked)
	}
}

func TestAFetchGoCannotAnswerIsReportedToTheSimulator(t *testing.T) {
	c := start(t)
	c.HandleFetch(func([]string) ([]Entry, error) {
		return nil, fmt.Errorf("%w: rpc down", exitcode.ErrNetwork)
	})
	_, err := c.Call(context.Background(), TypeSimulate, SimulateParams{ContractID: "C1", Function: "fetch", Args: []any{}}, nil)
	var se *Error
	if !errors.As(err, &se) || se.Code != "fetch_failed" || se.Detail["kind"] != "rpc_unavailable" {
		t.Fatalf("err = %#v", err)
	}
	// The process answered, so it is still the same one.
	if _, err := c.Call(context.Background(), TypeStatus, nil, nil); err != nil {
		t.Fatalf("status after a failed fetch: %v", err)
	}
}

func TestTranscriptErrors(t *testing.T) {
	c := startTranscript(t, "errors")
	ctx := context.Background()
	c.HandleFetch(func([]string) ([]Entry, error) { return nil, exitcode.ErrNetwork })

	cases := []struct {
		typ    string
		params any
		code   string
	}{
		{"frobnicate", nil, "bad_request"},
		{TypeLedgerOpen, map[string]any{"network_passphrase": 7}, "bad_request"},
		{TypeLedgerOpen, map[string]any{"network_passphrase": "Test SDF Network ; September 2015", "ledger_protocol": 99}, "unsupported_ledger_protocol"},
		{TypeSimulate, SimulateParams{ContractID: registry, Function: "lookup", Args: []any{"alice"}}, "fetch_failed"},
		{TypeContractInstall, ContractInstallParams{WasmBase64: "AGFzbQEAAAA="}, "resource_limit"},
	}
	for _, tc := range cases {
		ce, err := c.Call(ctx, tc.typ, tc.params, nil)
		var se *Error
		if ce != nil || !errors.As(err, &se) || se.Code != tc.code {
			t.Fatalf("%s: ce=%v err=%v, want code %s", tc.typ, ce, err, tc.code)
		}
		if !errors.Is(err, exitcode.ErrSimulator) {
			t.Fatalf("%s: an error response is a simulator failure", tc.typ)
		}
	}
}

func TestTimeoutSendsSIGTERMThenSIGKILL(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no SIGTERM on Windows; Process.Kill is used directly")
	}
	log, logOpt := newFakeLog(t)
	c := start(t, logOpt, WithEnv("FAKESIM_IGNORE_TERM=1"), WithTimeout(300*time.Millisecond))

	began := time.Now()
	_, err := c.Call(context.Background(), TypeSimulate, SimulateParams{ContractID: "C1", Function: "hang", Args: []any{}}, nil)
	took := time.Since(began)

	var te *TimeoutError
	if !errors.As(err, &te) || !errors.Is(err, exitcode.ErrTimeout) {
		t.Fatalf("err = %v, want a timeout", err)
	}
	if errors.Is(err, exitcode.ErrSimulator) {
		t.Fatal("a timeout must never be reported as a simulator error")
	}
	if !strings.Contains(err.Error(), "may be looping") {
		t.Fatalf("message should say the call may be looping: %q", err)
	}
	// The fake ignored SIGTERM, so only SIGKILL after the 2s grace ended it.
	if took < 300*time.Millisecond+stopGrace {
		t.Fatalf("returned after %s; the grace period before SIGKILL was skipped", took)
	}
	if got := types(log.byProcess(t)[0]); got[len(got)-1] != "SIGTERM" {
		t.Fatalf("the fake never saw SIGTERM: %v", got)
	}

	// The next call gets a fresh process.
	if _, err := c.Call(context.Background(), TypeStatus, nil, nil); err != nil {
		t.Fatalf("call after a timeout: %v", err)
	}
	if n := len(log.byProcess(t)); n != 2 {
		t.Fatalf("%d processes, want a respawn", n)
	}
}

func TestCrashMidCallSurfacesTheStderrTail(t *testing.T) {
	c := start(t)
	_, err := c.Call(context.Background(), TypeSimulate, SimulateParams{ContractID: "C1", Function: "crash", Args: []any{}}, nil)
	var se *Error
	if !errors.As(err, &se) || !errors.Is(err, exitcode.ErrSimulator) {
		t.Fatalf("err = %v, want a simulator failure", err)
	}
	if len(se.Stderr) != stderrTailLines || se.Stderr[0] != "panic line 11" || se.Stderr[49] != "panic line 60" {
		t.Fatalf("stderr tail = %d lines, %q … %q", len(se.Stderr), first(se.Stderr), last(se.Stderr))
	}
	if !strings.Contains(se.Message, "exit status 3") {
		t.Fatalf("message should say how it exited: %q", se.Message)
	}
}

func TestInternalPanicIsASimulatorFailure(t *testing.T) {
	c := start(t)
	_, err := c.Call(context.Background(), TypeSimulate, SimulateParams{ContractID: "C1", Function: "panic", Args: []any{}}, nil)
	var se *Error
	if !errors.As(err, &se) || se.Code != "internal_panic" {
		t.Fatalf("err = %v", err)
	}
	if _, err := c.Call(context.Background(), TypeStatus, nil, nil); err != nil {
		t.Fatalf("call after a panic: %v", err)
	}
}

func TestRespawnReplaysTheSession(t *testing.T) {
	log, logOpt := newFakeLog(t)
	c := start(t, logOpt, WithTimeout(500*time.Millisecond))
	ctx := context.Background()

	mustCall := func(typ string, params, result any) {
		t.Helper()
		if ce, err := c.Call(ctx, typ, params, result); err != nil || ce != nil {
			t.Fatalf("%s: ce=%v err=%v", typ, ce, err)
		}
	}
	mustCall(TypeLedgerOpen, LedgerOpenParams{NetworkPassphrase: "Test SDF Network ; September 2015"}, nil)
	var installed ContractInstallResult
	mustCall(TypeContractInstall, ContractInstallParams{WasmBase64: "AGFzbQEAAAA="}, &installed)
	mustCall(TypeLedgerPut, LedgerPutParams{Entries: []PutEntry{{KeyXDR: "AAAA", EntryXDR: "BBBB"}}}, nil)
	var cp LedgerCheckpointResult
	mustCall(TypeLedgerCheckpoint, LedgerCheckpointParams{Label: "before"}, &cp)
	mustCall(TypeLedgerPut, LedgerPutParams{Entries: []PutEntry{{KeyXDR: "CCCC", EntryXDR: "DDDD"}}}, nil)
	mustCall(TypeSimulate, SimulateParams{ContractID: installed.ContractID, Function: "count", Args: []any{}}, nil)

	// Kill it mid-call.
	if _, err := c.Call(ctx, TypeSimulate, SimulateParams{ContractID: installed.ContractID, Function: "hang", Args: []any{}}, nil); !errors.Is(err, exitcode.ErrTimeout) {
		t.Fatalf("hang: %v", err)
	}

	// The checkpoint id the caller holds came from the dead process; the
	// replay must translate it.
	mustCall(TypeLedgerRollback, LedgerRollbackParams(cp), nil)
	var st StatusResult
	mustCall(TypeStatus, nil, &st)
	if st.Contracts != 1 || st.Entries != 2 {
		t.Fatalf("status after respawn = %+v, want the replayed contract and both puts", st)
	}

	procs := log.byProcess(t)
	if len(procs) != 2 {
		t.Fatalf("%d processes, want 2", len(procs))
	}
	got := strings.Join(types(procs[1]), ",")
	want := "hello,ledger_open,contract_install,ledger_put,ledger_checkpoint,ledger_put,ledger_rollback,status"
	if got != want {
		t.Fatalf("replayed:\n got %s\nwant %s", got, want)
	}
	// The install is replayed at the address the first process chose.
	if !strings.Contains(procs[1][2], `"contract_id":"`+installed.ContractID+`"`) {
		t.Fatalf("replayed install: %s", procs[1][2])
	}
}

// fakeClock fires timers only when told to.
type fakeClock struct {
	mu     sync.Mutex
	timers []*fakeTimer
}

type fakeTimer struct {
	f       func()
	stopped bool
}

func (t *fakeTimer) Stop() bool { t.stopped = true; return true }

func (c *fakeClock) AfterFunc(_ time.Duration, f func()) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{f: f}
	c.timers = append(c.timers, t)
	return t
}

// fire runs the live timers, as if the idle timeout had elapsed.
func (c *fakeClock) fire() {
	c.mu.Lock()
	live := c.timers
	c.timers = nil
	c.mu.Unlock()
	for _, t := range live {
		if !t.stopped {
			t.f()
		}
	}
}

func TestIdleStopFreesTheProcessAndTheNextCallRespawns(t *testing.T) {
	log, logOpt := newFakeLog(t)
	clk := &fakeClock{}
	c := start(t, logOpt, WithClock(clk))
	ctx := context.Background()

	if _, err := c.Call(ctx, TypeLedgerOpen, LedgerOpenParams{NetworkPassphrase: "Test SDF Network ; September 2015"}, nil); err != nil {
		t.Fatal(err)
	}
	p := c.proc
	clk.fire()
	if c.proc != nil || p.alive() {
		t.Fatal("the idle stop left the process running")
	}
	if got := types(log.byProcess(t)[0]); got[len(got)-1] != "shutdown" {
		t.Fatalf("idle stop should ask the simulator to shut down: %v", got)
	}

	if _, err := c.Call(ctx, TypeStatus, nil, nil); err != nil {
		t.Fatalf("call after the idle stop: %v", err)
	}
	procs := log.byProcess(t)
	if len(procs) != 2 || strings.Join(types(procs[1]), ",") != "hello,ledger_open,status" {
		t.Fatalf("respawn after idle stop: %v", procs)
	}
}

func TestAStaleIdleTimerDoesNotStopABusyClient(t *testing.T) {
	clk := &fakeClock{}
	c := start(t, WithClock(clk))
	clk.mu.Lock()
	stale := clk.timers[0]
	clk.mu.Unlock()
	if _, err := c.Call(context.Background(), TypeStatus, nil, nil); err != nil {
		t.Fatal(err)
	}
	stale.f() // fires anyway, as a timer racing Stop could
	if c.proc == nil {
		t.Fatal("a timer from before the last call stopped the process")
	}
}

func TestConcurrentCallsAreSerialised(t *testing.T) {
	c := start(t)
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := c.Call(context.Background(), TypeSimulate, SimulateParams{ContractID: "C1", Function: "slow", Args: []any{}}, nil)
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent call: %v", err)
		}
	}
}

func TestTimeoutComesFromTheEnvironmentAndTheFlagWins(t *testing.T) {
	t.Setenv(TimeoutEnv, "42")
	c := start(t)
	if c.timeout != 42*time.Second {
		t.Fatalf("timeout = %s, want 42s from %s", c.timeout, TimeoutEnv)
	}
	c2 := start(t, WithTimeout(3*time.Second))
	if c2.timeout != 3*time.Second {
		t.Fatalf("timeout = %s, want the flag's 3s", c2.timeout)
	}

	t.Setenv(TimeoutEnv, "soon")
	if _, err := Start(context.Background(), buildFake(t)); !errors.Is(err, exitcode.ErrConfiguration) {
		t.Fatalf("a bad %s should be a configuration error: %v", TimeoutEnv, err)
	}
}

func TestParseTimeout(t *testing.T) {
	for in, want := range map[string]time.Duration{"30": 30 * time.Second, "1m": time.Minute, " 250ms ": 250 * time.Millisecond} {
		if got, err := ParseTimeout(in); err != nil || got != want {
			t.Errorf("ParseTimeout(%q) = %s, %v", in, got, err)
		}
	}
	for _, in := range []string{"", "0", "-5", "-1s", "soon"} {
		if _, err := ParseTimeout(in); err == nil {
			t.Errorf("ParseTimeout(%q) should fail", in)
		}
	}
}

func TestCancelledContextStopsTheProcess(t *testing.T) {
	c := start(t)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(100 * time.Millisecond); cancel() }()
	_, err := c.Call(ctx, TypeSimulate, SimulateParams{ContractID: "C1", Function: "hang", Args: []any{}}, nil)
	if !errors.Is(err, exitcode.ErrInterrupted) {
		t.Fatalf("err = %v, want interrupted", err)
	}
	if c.proc != nil {
		t.Fatal("the process should be gone after a cancel")
	}
}

func TestParamsMayNotSetEnvelopeFields(t *testing.T) {
	c := start(t)
	if _, err := c.Call(context.Background(), TypeStatus, map[string]any{"id": "x"}, nil); err == nil {
		t.Fatal("params setting `id` should be refused")
	}
}

func first(s []string) string {
	if len(s) == 0 {
		return ""
	}
	return s[0]
}

func last(s []string) string {
	if len(s) == 0 {
		return ""
	}
	return s[len(s)-1]
}
