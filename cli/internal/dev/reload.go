package dev

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"

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
}

// Cycle is what one reload produced, for the diff engine (#568) and the
// renderers.
type Cycle struct {
	// Deployed and Local are the A and B executables' hashes.
	Deployed string    `json:"deployed"`
	Local    string    `json:"local"`
	Outcomes []Outcome `json:"outcomes"`
	// Simulations is how many calls ran in the host this cycle; an A side
	// reused from the cache is not one.
	Simulations int `json:"simulations"`
	// Restarted are why the simulator was respawned since the last cycle
	// ("idle" after the five-minute idle stop): the respawn replayed the
	// fork, the installs and the base checkpoint, and that cost is said,
	// not hidden.
	Restarted []string `json:"restarted,omitempty"`
}

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
	// installed are the executables already in the session, by hash.
	installed map[string]bool
	// cached are A sides by replay fingerprint: A changes only when the
	// fork or the call does, and a new fork is a new Reloader.
	cached map[string]Run
}

// NewReloader takes the session's `base`: contract's instance and deployed
// executable are read into the ledger first (contract_info fetches both),
// so every cycle starts from the same state. The ledger must be open.
func NewReloader(ctx context.Context, host Host, contract string) (*Reloader, error) {
	var info simulator.ContractInfoResult
	if err := call(ctx, host, simulator.TypeContractInfo, simulator.ContractInfoParams{ContractID: contract}, &info); err != nil {
		return nil, err
	}
	if info.WasmHash == nil {
		return nil, fmt.Errorf("%s runs a %s executable, not WASM: signet dev needs a WASM contract", contract, info.Executable)
	}
	var cp simulator.LedgerCheckpointResult
	if err := call(ctx, host, simulator.TypeLedgerCheckpoint, simulator.LedgerCheckpointParams{Label: "base"}, &cp); err != nil {
		return nil, err
	}
	return &Reloader{
		host: host, contract: contract, base: cp.Checkpoint, deployed: *info.WasmHash,
		installed: map[string]bool{*info.WasmHash: true}, cached: map[string]Run{},
	}, nil
}

// Deployed is the deployed executable's hash.
func (r *Reloader) Deployed() string { return r.deployed }

// Cycle installs wasm (once per distinct build) and runs every replay as A
// and as B, each from `base`. Replay i runs with call index i's PRNG seed
// on both sides, so a contract drawing from env.prng() sees the same values
// in A and B, and in every cycle.
func (r *Reloader) Cycle(ctx context.Context, wasm []byte, replays []Replay) (Cycle, error) {
	sum := sha256.Sum256(wasm)
	local := hex.EncodeToString(sum[:])
	if !r.installed[local] {
		var installed simulator.ContractInstallResult
		if err := call(ctx, r.host, simulator.TypeContractInstall, simulator.ContractInstallParams{
			WasmBase64: base64.StdEncoding.EncodeToString(wasm),
		}, &installed); err != nil {
			return Cycle{}, fmt.Errorf("installing the new build: %w", err)
		}
		r.installed[local] = true
	}
	out := Cycle{Deployed: r.deployed, Local: local, Outcomes: make([]Outcome, 0, len(replays))}
	for i, replay := range replays {
		params := replay.Params
		params.ContractID = r.contract
		index := uint64(i)
		params.CallIndex = &index
		key, err := fingerprint(params)
		if err != nil {
			return Cycle{}, err
		}
		o := Outcome{Name: replay.Name}
		if a, ok := r.cached[key]; ok {
			o.A = a
			o.A.Cached = true
		} else {
			if o.A, err = r.run(ctx, params, ""); err != nil {
				return Cycle{}, fmt.Errorf("%s on the deployed code: %w", replay.Name, err)
			}
			out.Simulations++
			r.cached[key] = o.A
		}
		if o.B, err = r.run(ctx, params, local); err != nil {
			return Cycle{}, fmt.Errorf("%s on the new build: %w", replay.Name, err)
		}
		out.Simulations++
		if o.Diff, err = r.diff(ctx, o); err != nil {
			return Cycle{}, fmt.Errorf("comparing %s: %w", replay.Name, err)
		}
		out.Outcomes = append(out.Outcomes, o)
	}
	// Leave the session at base, as the next cycle expects it.
	if err := r.rollback(ctx); err != nil {
		return Cycle{}, err
	}
	if h, ok := r.host.(restarter); ok {
		out.Restarted = h.TakeRestarts()
	}
	return out, nil
}

// run rolls back to base and runs one call, on the executable swapped in
// when swap is set and on the deployed one otherwise.
func (r *Reloader) run(ctx context.Context, params simulator.SimulateParams, swap string) (Run, error) {
	if err := r.rollback(ctx); err != nil {
		return Run{}, err
	}
	if swap != "" && swap != r.deployed {
		if err := call(ctx, r.host, simulator.TypeContractSwap, simulator.ContractSwapParams{
			ContractID: r.contract, WasmHash: swap, Mode: "instance",
		}, nil); err != nil {
			return Run{}, fmt.Errorf("swapping in the new build: %w", err)
		}
	}
	var res simulator.SimulateResult
	ce, err := r.host.Call(ctx, simulator.TypeSimulate, params, &res)
	switch {
	case err != nil:
		return Run{}, err
	case ce != nil:
		return Run{Error: ce}, nil
	}
	return Run{Result: &res}, nil
}

// diff compares an outcome's sides in the simulator, where the values are
// exact (#568).
func (r *Reloader) diff(ctx context.Context, o Outcome) (*simulator.DiffResultsResult, error) {
	var d simulator.DiffResultsResult
	if err := call(ctx, r.host, simulator.TypeDiffResults, simulator.DiffResultsParams{
		A: simulator.DiffSideOf(o.A.Result, o.A.Error), B: simulator.DiffSideOf(o.B.Result, o.B.Error),
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
