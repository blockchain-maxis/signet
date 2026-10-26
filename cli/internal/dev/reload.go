package dev

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/devconfig"
	"github.com/blockchain-maxis/signet/cli/internal/realtx"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// Host is the simulator session a reload cycle drives; *simulator.Client is
// one.
type Host interface {
	Call(ctx context.Context, typ string, params, result any) (*simulator.ContractError, error)
}

// restarter is a Host that says when it was respawned.
type restarter interface {
	TakeRestarts() []string
}

// Replay is one call a cycle runs on both sides.
type Replay struct {
	Name   string
	Params simulator.SimulateParams
	// Chain starts the call from the previous call's end state, on both
	// sides, instead of from base (#567).
	Chain bool
	// Expect is what the call should do on the new build (#567); the zero
	// value checks nothing.
	Expect devconfig.Expect
	// Real is set on a real transaction's replay (#636): its A side is then
	// checked against what the chain did.
	Real *RealTx
}

// RealTx is a real transaction behind a replay.
type RealTx struct {
	Tx   realtx.Tx
	Link string
}

// RealOutcome is a real transaction's replay: where it came from, and
// whether the deployed code here behaved as it did on-chain.
type RealOutcome struct {
	Hash     string          `json:"hash"`
	Ledger   uint32          `json:"ledger"`
	Function string          `json:"function"`
	Link     string          `json:"link,omitempty"`
	Fidelity realtx.Fidelity `json:"fidelity"`
}

// Verdict is how a call met its expect.
type Verdict struct {
	Expect string `json:"expect"`
	Pass   bool   `json:"pass"`
	// Reason says why a check failed.
	Reason string `json:"reason,omitempty"`
}

// Run is one side's outcome: a result, or the contract error it ended in.
type Run struct {
	Result *simulator.SimulateResult `json:"result,omitempty"`
	Error  *simulator.ContractError  `json:"error,omitempty"`
	// Cached is set on an A side reused from an earlier cycle.
	Cached bool `json:"cached,omitempty"`
}

// Outcome is one replay on the deployed code (A) and the new code (B), and
// what differs between them (#568).
type Outcome struct {
	Name string                       `json:"name"`
	A    Run                          `json:"a"`
	B    Run                          `json:"b"`
	Diff *simulator.DiffResultsResult `json:"diff"`
	// Verdict is how B met the call's expect; nil when it has none.
	Verdict *Verdict `json:"verdict,omitempty"`
	// Real is set when the call is a real transaction (#636).
	Real *RealOutcome `json:"real,omitempty"`
}

// Cycle is what one reload produced, for the diff engine (#568) and the
// renderers.
type Cycle struct {
	// Deployed and Local are the A and B executables' hashes.
	Deployed string    `json:"deployed"`
	Local    string    `json:"local"`
	Outcomes []Outcome `json:"outcomes"`
	// Spec is how the build's interface differs from the deployed one's
	// (#570), worked out once per build.
	Spec *simulator.SpecDiffResult `json:"spec,omitempty"`
	// Layout is whether the build reads what the deployed code stored
	// (#571), from the stored entries and this cycle's failed replays.
	Layout *simulator.LayoutCheckResult `json:"layout,omitempty"`
	// Simulations is how many calls ran in the host this cycle; an A side
	// reused from the cache is not one.
	Simulations int `json:"simulations"`
	// Restarted are why the simulator was respawned since the last cycle
	// ("idle" after the five-minute idle stop): the respawn replayed the
	// fork, the installs and the base checkpoint, and that cost is said,
	// not hidden.
	Restarted []string `json:"restarted,omitempty"`
	// Timing is where the cycle's time went (#637, #638).
	Timing Timing `json:"timing"`
}

// Timing is a cycle's time by phase: installing the build, swapping it
// into the instance, the A and the B runs, and the comparisons (the diffs,
// the interface and the storage layout).
type Timing struct {
	Install time.Duration `json:"install_ns"`
	Swap    time.Duration `json:"swap_ns"`
	A       time.Duration `json:"a_ns"`
	B       time.Duration `json:"b_ns"`
	Diff    time.Duration `json:"diff_ns"`
}

// Replays is the time the replays took: both sides and their diffs.
func (t Timing) Replays() time.Duration { return t.A + t.B + t.Diff }

// Reloader runs the reload cycle (#566): each saved call on the deployed
// executable (A) and on the newly built one (B), both from the same `base`
// checkpoint, in one simulator session that stays warm across cycles.
//
// Module parsing is not cached across calls. Measured on the registry
// (identity-registry.wasm, 6,240 bytes) in release, building the VM is about
// 65% of a `count` simulate on p28 and 60% on p29 (the ignored
// module_parse_share test in sandbox/simulator/src/lanes/host_lane.rs), but
// the known-footprint fast path (enforcing invoke_host_function with the
// previous run's footprint and a ModuleCache) cannot see a footprint that
// shrank, so a read the new build dropped would still be reported, and a
// cached module is charged less than recording mode charges A: both would
// show up as differences in the A/B diff that are not in the code. The A
// side is cached instead, which halves the host runs of every cycle after
// the first.
type Reloader struct {
	host     Host
	contract string
	base     string
	deployed string
	// deployedWasm is the deployed executable, for a repro bundle (#572).
	deployedWasm []byte
	// installed are the executables already in the session, by hash.
	installed map[string]bool
	// cached are A sides by replay fingerprint: A changes only when the
	// fork or the call does, and a new fork is a new Reloader.
	cached map[string]Run
	// rules are signet.dev.toml's [diff] (#569).
	rules *simulator.DiffRules
	// specs are spec_diff results by build hash.
	specs map[string]*simulator.SpecDiffResult
	// trace asks each replay for its call tree (SetTrace).
	trace bool
}

// SetRules sets what the diffs leave out or tolerate; nil for none.
func (r *Reloader) SetRules(rules *simulator.DiffRules) { r.rules = rules }

// Rules are the diff rules in use.
func (r *Reloader) Rules() *simulator.DiffRules { return r.rules }

// RulesOf turns signet.dev.toml's [diff] into diff_results rules for
// contract: a tolerance of "10%" is a percentage of A's, "500" an amount,
// and fee is the resource fee.
func RulesOf(d devconfig.Diff, contract string) (*simulator.DiffRules, error) {
	out := &simulator.DiffRules{
		ContractID: contract, IgnoreEvents: d.IgnoreEvents, IgnoreStorage: d.IgnoreStorage, IgnoreAuth: d.IgnoreAuth,
	}
	for metric, text := range d.ResourceTolerance {
		var t simulator.Tolerance
		if p, ok := strings.CutSuffix(text, "%"); ok {
			v, err := strconv.ParseFloat(p, 64)
			if err != nil {
				return nil, fmt.Errorf("resource_tolerance %s: %q is not a percentage", metric, text)
			}
			t.Percent = &v
		} else {
			v, err := strconv.ParseInt(text, 10, 64)
			if err != nil {
				return nil, fmt.Errorf("resource_tolerance %s: %q is not an amount", metric, text)
			}
			t.Absolute = &v
		}
		if metric == "fee" {
			metric = "resource_fee"
		}
		if out.ResourceTolerance == nil {
			out.ResourceTolerance = map[string]simulator.Tolerance{}
		}
		out.ResourceTolerance[metric] = t
	}
	return out, nil
}

// NewReloader takes the session's `base`: contract's instance and deployed
// executable are read into the ledger first (contract_info fetches both),
// so every cycle starts from the same state. The ledger must be open.
func NewReloader(ctx context.Context, host Host, contract string) (*Reloader, error) {
	var info simulator.ContractInfoResult
	if err := call(ctx, host, simulator.TypeContractInfo, simulator.ContractInfoParams{ContractID: contract, IncludeWasm: true}, &info); err != nil {
		return nil, err
	}
	if info.WasmHash == nil {
		return nil, fmt.Errorf("%s runs a %s executable, not WASM: signet dev needs a WASM contract", contract, info.Executable)
	}
	var cp simulator.LedgerCheckpointResult
	if err := call(ctx, host, simulator.TypeLedgerCheckpoint, simulator.LedgerCheckpointParams{Label: "base"}, &cp); err != nil {
		return nil, err
	}
	deployedWasm, err := base64.StdEncoding.DecodeString(info.WasmBase64)
	if err != nil {
		return nil, fmt.Errorf("the deployed executable is not base64: %w", err)
	}
	return &Reloader{
		host: host, contract: contract, base: cp.Checkpoint, deployed: *info.WasmHash, deployedWasm: deployedWasm,
		installed: map[string]bool{*info.WasmHash: true}, cached: map[string]Run{},
		specs: map[string]*simulator.SpecDiffResult{},
	}, nil
}

// SetTrace asks every replay for its call tree (#541), for the local UI's
// Diagram view (#580). Off by default: a trace is the size of the call.
func (r *Reloader) SetTrace(on bool) { r.trace = on }

// Deployed is the deployed executable's hash.
func (r *Reloader) Deployed() string { return r.deployed }

// DeployedWasm is the deployed executable.
func (r *Reloader) DeployedWasm() []byte { return r.deployedWasm }

// Cycle installs wasm (once per distinct build) and runs every replay as A
// and as B. Each starts from `base`, unless it chains, when it continues
// from the previous call's end state on its side. Replay i runs with call
// index i's PRNG seed on both sides, so a contract drawing from env.prng()
// sees the same values in A and B, and in every cycle.
func (r *Reloader) Cycle(ctx context.Context, wasm []byte, replays []Replay) (Cycle, error) {
	sum := sha256.Sum256(wasm)
	local := hex.EncodeToString(sum[:])
	var timing Timing
	since := func(d *time.Duration, start time.Time) { *d += time.Since(start) }
	began := time.Now()
	if !r.installed[local] {
		var installed simulator.ContractInstallResult
		if err := call(ctx, r.host, simulator.TypeContractInstall, simulator.ContractInstallParams{
			WasmBase64: base64.StdEncoding.EncodeToString(wasm),
		}, &installed); err != nil {
			return Cycle{}, fmt.Errorf("installing the new build: %w", err)
		}
		r.installed[local] = true
	}
	since(&timing.Install, began)
	out := Cycle{Deployed: r.deployed, Local: local, Outcomes: make([]Outcome, 0, len(replays))}
	began = time.Now()
	if out.Spec = r.specs[local]; out.Spec == nil {
		// The session is at base here, where the instance runs the
		// deployed executable.
		var spec simulator.SpecDiffResult
		if err := call(ctx, r.host, simulator.TypeSpecDiff, simulator.SpecDiffParams{
			Old: simulator.Source{ContractID: r.contract},
			New: simulator.Source{WasmBase64: base64.StdEncoding.EncodeToString(wasm)},
		}, &spec); err != nil {
			return Cycle{}, fmt.Errorf("comparing the interfaces: %w", err)
		}
		out.Spec, r.specs[local] = &spec, &spec
	}
	since(&timing.Diff, began)
	for start := 0; start < len(replays); {
		end := start + 1
		for end < len(replays) && replays[end].Chain {
			end++
		}
		outcomes, runs, err := r.chain(ctx, replays[start:end], start, local, &timing)
		if err != nil {
			return Cycle{}, err
		}
		out.Outcomes = append(out.Outcomes, outcomes...)
		out.Simulations += runs
		start = end
	}
	// Leave the session at base, as the next cycle expects it.
	if err := r.rollback(ctx); err != nil {
		return Cycle{}, err
	}
	began = time.Now()
	layout, err := r.layout(ctx, wasm, out.Outcomes)
	if err != nil {
		return Cycle{}, err
	}
	since(&timing.Diff, began)
	out.Layout, out.Timing = layout, timing
	if h, ok := r.host.(restarter); ok {
		out.Restarted = h.TakeRestarts()
	}
	return out, nil
}

// chain runs one call and the calls chained to it, the first at index
// first: all of A from base, then all of B from base with the build
// swapped in. A is cached by the chain up to each call, so a chained
// call's A is reused only when everything before it is the same.
func (r *Reloader) chain(ctx context.Context, replays []Replay, first int, local string, timing *Timing) ([]Outcome, int, error) {
	params := make([]simulator.SimulateParams, len(replays))
	keys := make([]string, len(replays))
	cached := true
	for j, replay := range replays {
		p := replay.Params
		p.ContractID = r.contract
		if r.trace {
			p.Trace = true
		}
		index := uint64(first + j)
		p.CallIndex = &index
		fp, err := fingerprint(p)
		if err != nil {
			return nil, 0, err
		}
		if j > 0 {
			sum := sha256.Sum256([]byte(keys[j-1] + fp))
			fp = hex.EncodeToString(sum[:])
		}
		params[j], keys[j] = p, fp
		_, ok := r.cached[fp]
		cached = cached && ok
	}
	outcomes := make([]Outcome, len(replays))
	runs := 0
	if cached {
		for j := range replays {
			outcomes[j].A = r.cached[keys[j]]
			outcomes[j].A.Cached = true
		}
	} else {
		if err := r.begin(ctx, ""); err != nil {
			return nil, 0, err
		}
		for j, replay := range replays {
			began := time.Now()
			a, err := r.simulate(ctx, params[j])
			timing.A += time.Since(began)
			if err != nil {
				return nil, 0, fmt.Errorf("%s on the deployed code: %w", replay.Name, err)
			}
			outcomes[j].A, r.cached[keys[j]] = a, a
			runs++
		}
	}
	began := time.Now()
	if err := r.begin(ctx, local); err != nil {
		return nil, 0, err
	}
	for j, replay := range replays {
		if j == 0 {
			timing.Swap += time.Since(began)
		}
		began = time.Now()
		b, err := r.simulate(ctx, params[j])
		timing.B += time.Since(began)
		if err != nil {
			return nil, 0, fmt.Errorf("%s on the new build: %w", replay.Name, err)
		}
		runs++
		o := &outcomes[j]
		o.Name, o.B = replay.Name, b
		began = time.Now()
		o.Diff, err = r.diff(ctx, *o)
		timing.Diff += time.Since(began)
		if err != nil {
			return nil, 0, fmt.Errorf("comparing %s: %w", replay.Name, err)
		}
		o.Verdict = verdict(replay.Expect, *o)
		if replay.Real != nil {
			t := replay.Real.Tx
			o.Real = &RealOutcome{Hash: t.Hash, Ledger: t.Ledger, Function: t.Function(), Link: replay.Real.Link,
				Fidelity: realtx.CheckFidelity(t, o.A.Result, o.A.Error)}
		}
	}
	return outcomes, runs, nil
}

// layout checks, at base, that the build reads what the contract stored:
// every entry of it the session knows, and as evidence the calls that ran
// on the deployed code and failed on the build, with the keys A read.
func (r *Reloader) layout(ctx context.Context, wasm []byte, outcomes []Outcome) (*simulator.LayoutCheckResult, error) {
	var replays []simulator.LayoutReplay
	for _, o := range outcomes {
		if o.A.Result == nil || o.B.Error == nil || o.A.Result.Resources == nil {
			continue
		}
		fp := o.A.Result.Resources.Footprint
		replays = append(replays, simulator.LayoutReplay{
			Name: o.Name, Error: o.B.Error.Code,
			Keys: append(append([]string{}, fp.ReadOnly...), fp.ReadWrite...),
		})
	}
	var out simulator.LayoutCheckResult
	if err := call(ctx, r.host, simulator.TypeLayoutCheck, simulator.LayoutCheckParams{
		Old:        simulator.Source{ContractID: r.contract},
		New:        simulator.Source{WasmBase64: base64.StdEncoding.EncodeToString(wasm)},
		ContractID: r.contract, Replays: replays,
	}, &out); err != nil {
		return nil, fmt.Errorf("checking the storage layout: %w", err)
	}
	return &out, nil
}

// begin rolls back to base and, for B, swaps the build into the instance.
func (r *Reloader) begin(ctx context.Context, swap string) error {
	if err := r.rollback(ctx); err != nil {
		return err
	}
	if swap == "" || swap == r.deployed {
		return nil
	}
	if err := call(ctx, r.host, simulator.TypeContractSwap, simulator.ContractSwapParams{
		ContractID: r.contract, WasmHash: swap, Mode: "instance",
	}, nil); err != nil {
		return fmt.Errorf("swapping in the new build: %w", err)
	}
	return nil
}

// simulate runs one call where the session stands; its writes stay, for a
// chained call after it.
func (r *Reloader) simulate(ctx context.Context, params simulator.SimulateParams) (Run, error) {
	var res simulator.SimulateResult
	ce, err := r.host.Call(ctx, simulator.TypeSimulate, params, &res)
	var refused *simulator.Error
	switch {
	case errors.As(err, &refused) && refusedCall(refused):
		// The executable cannot take this call at all (a saved call's
		// function was removed, or its arguments no longer encode): that
		// side failed, and the diff and expect say so; the cycle goes on.
		return Run{Error: &simulator.ContractError{Kind: "call", Code: "Refused", Message: refused.Message}}, nil
	case err != nil:
		return Run{}, err
	case ce != nil:
		return Run{Error: ce}, nil
	}
	return Run{Result: &res}, nil
}

// refusedCall is the simulator refusing a call for what the executable is
// (its function or its arguments), not for how it was asked.
func refusedCall(e *simulator.Error) bool {
	if e.Code != "bad_request" {
		return false
	}
	path, _ := e.Detail["path"].(string)
	return path == "function" || path == "args" || strings.HasPrefix(path, "args.") || strings.HasPrefix(path, "args[")
}

// verdict checks B against expect: unchanged (no difference from A beyond
// what the [diff] rules ignore), ok (B did not fail), error:<Name> (B failed
// with that contract error), or any.
func verdict(expect devconfig.Expect, o Outcome) *Verdict {
	if expect.Kind == "" {
		return nil
	}
	text, _ := expect.MarshalText()
	v := &Verdict{Expect: string(text), Pass: true}
	fail := func(format string, args ...any) *Verdict {
		v.Pass, v.Reason = false, fmt.Sprintf(format, args...)
		return v
	}
	switch expect.Kind {
	case "unchanged":
		if o.Diff == nil {
			return fail("the sides were not compared")
		}
		if s := o.Diff.Summary; !s.Clean() {
			return fail("A and B differ: %d breaking, %d behavioural, %d cost", s.Breaking, s.Behavioural, s.Cost)
		}
	case "ok":
		if o.B.Error != nil {
			return fail("it failed with %s", errorName(o.B.Error))
		}
	case "error":
		switch {
		case o.B.Error == nil:
			return fail("it returned instead of failing with %s", expect.Error)
		case errorName(o.B.Error) != expect.Error:
			return fail("it failed with %s, not %s", errorName(o.B.Error), expect.Error)
		}
	}
	return v
}

// errorName is a contract error's name from the spec, or its code.
func errorName(ce *simulator.ContractError) string {
	if ce.Decoded != nil && ce.Decoded.ErrorName != "" {
		return ce.Decoded.ErrorName
	}
	return ce.Code
}

// diff compares an outcome's sides in the simulator, where the values are
// exact (#568).
func (r *Reloader) diff(ctx context.Context, o Outcome) (*simulator.DiffResultsResult, error) {
	var d simulator.DiffResultsResult
	if err := call(ctx, r.host, simulator.TypeDiffResults, simulator.DiffResultsParams{
		A: simulator.DiffSideOf(o.A.Result, o.A.Error), B: simulator.DiffSideOf(o.B.Result, o.B.Error),
		Rules: r.rules,
	}, &d); err != nil {
		return nil, err
	}
	return &d, nil
}

func (r *Reloader) rollback(ctx context.Context) error {
	return call(ctx, r.host, simulator.TypeLedgerRollback, simulator.LedgerRollbackParams{Checkpoint: r.base}, nil)
}

// call is a request that must succeed: a contract error is a failure too.
func call(ctx context.Context, host Host, typ string, params, result any) error {
	ce, err := host.Call(ctx, typ, params, result)
	if err != nil {
		return err
	}
	if ce != nil {
		return fmt.Errorf("%s: %s", typ, ce.Message)
	}
	return nil
}

// fingerprint identifies a replay's inputs for the A-side cache.
func fingerprint(params simulator.SimulateParams) (string, error) {
	b, err := json.Marshal(params)
	if err != nil {
		return "", fmt.Errorf("encoding a replay: %w", err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}
