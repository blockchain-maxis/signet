package cmd

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/bundle"
	"github.com/blockchain-maxis/signet/cli/internal/dev"
	"github.com/blockchain-maxis/signet/cli/internal/devconfig"
	"github.com/blockchain-maxis/signet/cli/internal/devui"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/fork"
	"github.com/blockchain-maxis/signet/cli/internal/rpc"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// devSession is the warm simulator session signet dev's cycles run in
// (#566): the fork open in the host, the file's storage overrides applied
// (#567), and the reloader's base taken.
type devSession struct {
	reloader  *dev.Reloader
	cache     *fork.Cache
	sim       *simulator.Client
	manifest  fork.Manifest
	overrides []devconfig.Override
	forkID    string
	// log is the session log export reads (#572); nil until started.
	log *bundle.Log

	// mu keeps a reload cycle and a UI request (#577) from using the
	// simulator at once.
	mu sync.Mutex
	// cycles are the latest cycles, for the UI, oldest first.
	cycles []storedCycle
	// events is the UI's event stream; nil without --ui.
	events *devui.Events
	// real are the contract's recent real transactions as replays (#636).
	real []dev.Replay
	// view is how cycles print (#637).
	view dev.RenderOptions
}

// storedCycle is a cycle as the UI fetches it.
type storedCycle struct {
	ID int `json:"id"`
	dev.Cycle
}

// keptCycles bounds what the session keeps for the UI.
const keptCycles = 50

// publish sends an event to the UI, if one is listening.
func (s *devSession) publish(typ string, data any) {
	if s.events != nil {
		s.events.Publish(typ, data)
	}
}

// cycle is a stored cycle by id, or "latest".
func (s *devSession) cycle(id string) (any, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.cycles) == 0 {
		return nil, false
	}
	if id == "latest" {
		return s.cycles[len(s.cycles)-1], true
	}
	for _, c := range s.cycles {
		if strconv.Itoa(c.ID) == id {
			return c, true
		}
	}
	return nil, false
}

func (s *devSession) Close() {
	if s.cache != nil {
		_ = s.cache.Close()
	}
}

// openDevSession opens the fork of contract in sim, answering its fetches
// from the fork cache and the RPC, applies overrides, and takes the
// reloader's base.
func openDevSession(ctx context.Context, deps Deps, network rpc.Network, client *rpc.Client, sim *simulator.Client, m fork.Manifest, overrides []devconfig.Override) (*devSession, error) {
	root, err := forkRoot(deps)
	if err != nil {
		return nil, err
	}
	info, err := latestFork(root, network, m.Contract)
	if err != nil || info == nil {
		return nil, fmt.Errorf("%w: the fork of %s is not in the cache: %v", exitcode.ErrConfiguration, m.Contract, err)
	}
	cache, err := fork.Open(root, network.Passphrase, info.ID)
	if err != nil {
		return nil, err
	}
	s := &devSession{cache: cache, sim: sim, manifest: m, forkID: info.ID}
	sim.HandleFetch((&fork.Fetcher{Ctx: ctx, Cache: cache, RPC: client, ForkLedger: m.ForkLedger}).Fetch)
	if err := s.reset(ctx, overrides); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

// reset opens the ledger afresh with overrides applied and a new base:
// overrides are part of what A ran on, so new ones start the session over,
// A's cache with it.
func (s *devSession) reset(ctx context.Context, overrides []devconfig.Override) error {
	m := s.manifest
	protocol, sequence, timestamp := m.Protocol, m.ForkLedger, uint64(m.ForkTime.Unix())
	if _, err := callSimulator(ctx, s.sim, simulator.TypeLedgerOpen, simulator.LedgerOpenParams{
		NetworkPassphrase: m.Passphrase, LedgerProtocol: &protocol, Sequence: &sequence, Timestamp: &timestamp,
		SessionID: devSessionID,
	}, nil); err != nil {
		return err
	}
	for i, o := range overrides {
		if _, err := callSimulator(ctx, s.sim, simulator.TypeStorageOverride, simulator.StorageOverrideParams{
			ContractID: m.Contract, Durability: o.Durability, Key: o.Key, Value: o.Value, Unset: o.Unset,
		}, nil); err != nil {
			return asInputError(err, fmt.Sprintf("signet.dev.toml override %d", i+1))
		}
	}
	reloader, err := dev.NewReloader(ctx, s.sim, m.Contract)
	if err != nil {
		return fmt.Errorf("%w: %v", exitcode.ErrSimulator, err)
	}
	if s.reloader != nil {
		reloader.SetRules(s.reloader.Rules())
	}
	// The UI's Diagram view (#580) draws the replays' call trees.
	reloader.SetTrace(s.events != nil)
	s.reloader, s.overrides = reloader, overrides
	return nil
}

// devSessionID names signet dev's sessions: every call's PRNG seed derives
// from it and the call's index (#537), so a replay of a bundle must use it
// too.
const devSessionID = "signet-dev"

// fileOverrides are a file's [[override]]s; none without a file.
func fileOverrides(f *devconfig.File) []devconfig.Override {
	if f == nil {
		return nil
	}
	return f.Overrides
}

// devReplays are the saved calls of signet.dev.toml, in file order.
func devReplays(f *devconfig.File) []dev.Replay {
	if f == nil {
		return nil
	}
	out := make([]dev.Replay, len(f.Calls))
	for i, c := range f.Calls {
		args := c.Args
		if args == nil {
			args = map[string]any{}
		}
		name := c.Name
		if name == "" {
			name = c.Function
		}
		out[i] = dev.Replay{Name: name, Params: simulator.SimulateParams{Function: c.Function, Args: args}, Chain: c.Chain, Expect: c.Expect}
	}
	return out
}

// runCycle runs the saved calls on the deployed code and on the build at
// wasmPath, and says what each returned.
// build is how long building it took; 0 replays the current build again.
func (s *devSession) runCycle(ctx context.Context, wasmPath string, build time.Duration, replays []dev.Replay, progress func(string)) (dev.Cycle, error) {
	wasm, err := os.ReadFile(wasmPath)
	if err != nil {
		return dev.Cycle{}, fmt.Errorf("%w: reading the build: %v", exitcode.ErrConfiguration, err)
	}
	s.mu.Lock()
	cycle, err := s.reloader.Cycle(ctx, wasm, replays)
	id := 1
	if err == nil {
		if n := len(s.cycles); n > 0 {
			id = s.cycles[n-1].ID + 1
		}
		s.cycles = append(s.cycles, storedCycle{ID: id, Cycle: cycle})
		if len(s.cycles) > keptCycles {
			s.cycles = s.cycles[len(s.cycles)-keptCycles:]
		}
	}
	s.mu.Unlock()
	if err != nil {
		return dev.Cycle{}, fmt.Errorf("%w: %v", exitcode.ErrSimulator, err)
	}
	s.publish("cycle.completed", map[string]int{"id": id})
	if n := s.manifest.DriftedEntries; n > 0 {
		s.publish("drift", map[string]int{"count": n})
	}
	progress(strings.TrimSuffix(dev.Render(dev.Frame{Build: build, Cycle: &cycle}, s.view), "\n"))
	if s.log != nil {
		if err := s.log.Cycle(wasm, cycleRecord(cycle, replays, s.overrides), time.Now()); err != nil {
			progress("warning: the session log could not be written: " + err.Error())
		}
	}
	return cycle, nil
}

// buildFailed says a build failed and which build is still active: the
// one at wasmPath, or none yet.
func (s *devSession) buildFailed(took time.Duration, wasmPath string, err error, progress func(string)) {
	active := ""
	if wasmPath != "" {
		if wasm, rerr := os.ReadFile(wasmPath); rerr == nil {
			sum := sha256.Sum256(wasm)
			active = hex.EncodeToString(sum[:])
		}
	}
	progress(strings.TrimSuffix(dev.Render(dev.Frame{Build: took, BuildError: err.Error(), Active: active}, s.view), "\n"))
}

// startLog begins the session log in dir (#572).
func (s *devSession) startLog(dir, cliVersion string) error {
	m := s.manifest
	rec := bundle.Session{
		CreatedBy: "signet " + cliVersion, Contract: m.Contract,
		Network:   bundle.Network{Name: m.Network, Passphrase: m.Passphrase, Protocol: m.Protocol},
		Simulator: bundle.Simulator{Version: s.sim.HelloAck().SimulatorVersion, Lane: m.Protocol},
		Deployed:  bundle.WasmOf(s.reloader.DeployedWasm()),
	}
	rec.Fork.ID, rec.Fork.Ledger, rec.Fork.Timestamp, rec.Fork.Consistent = s.forkID, m.ForkLedger, uint64(m.ForkTime.Unix()), m.Consistent
	log, err := bundle.NewLog(dir, rec, time.Now())
	if err != nil {
		return err
	}
	s.log = log
	return nil
}

// bundleSide is what one side returned, as a bundle keeps it.
func bundleSide(r dev.Run) bundle.Side {
	if r.Error != nil {
		return bundle.Side{Outcome: "error", Error: r.Error.Code}
	}
	if r.Result == nil {
		return bundle.Side{Outcome: "error"}
	}
	return bundle.Side{Outcome: "ok", ReturnValueXDR: r.Result.ReturnValueXDR}
}

// cycleRecord is a cycle as the session log keeps it: the calls, what each
// side returned, and every key a footprint read.
func cycleRecord(c dev.Cycle, replays []dev.Replay, overrides []devconfig.Override) bundle.Cycle {
	keys := map[string]bool{}
	read := func(r dev.Run) {
		if r.Result != nil && r.Result.Resources != nil {
			for _, k := range append(append([]string{}, r.Result.Resources.Footprint.ReadOnly...), r.Result.Resources.Footprint.ReadWrite...) {
				keys[k] = true
			}
		}
	}
	out := bundle.Cycle{Overrides: bundle.OverridesOf(overrides), Calls: []bundle.Call{}, Expected: []bundle.Expected{}, Keys: []string{}}
	for i, r := range replays {
		args, _ := r.Params.Args.(map[string]any)
		if args == nil {
			args = map[string]any{}
		}
		expect, _ := r.Expect.MarshalText()
		if r.Expect.Kind == "" {
			expect = nil
		}
		call := bundle.Call{Name: r.Name, Function: r.Params.Function, Args: args, Chain: r.Chain, Expect: string(expect), Source: "saved"}
		if r.Real != nil {
			call.Source, call.ArgsXDR, call.SourceAccount, call.Tx = "real", r.Params.ArgsXDR, r.Params.SourceAccount, r.Real.Tx.Hash
		}
		out.Calls = append(out.Calls, call)
		if i < len(c.Outcomes) {
			o := c.Outcomes[i]
			out.Expected = append(out.Expected, bundle.Expected{Name: o.Name, A: bundleSide(o.A), B: bundleSide(o.B)})
			read(o.A)
			read(o.B)
		}
	}
	for k := range keys {
		out.Keys = append(out.Keys, k)
	}
	sort.Strings(out.Keys)
	return out
}

// applyFile hands signet.dev.toml to the session: its [diff] rules, and
// its overrides, starting the session over when they changed.
func (s *devSession) applyFile(ctx context.Context, f *devconfig.File, contract string, progress func(string)) error {
	if overrides := fileOverrides(f); !reflect.DeepEqual(overrides, s.overrides) {
		s.mu.Lock()
		err := s.reset(ctx, overrides)
		s.mu.Unlock()
		if err != nil {
			return err
		}
		progress(fmt.Sprintf("storage overrides changed: %d applied, from a new base", len(overrides)))
	}
	return s.applyRules(f, contract, progress)
}

// applyRules hands signet.dev.toml's [diff] to the session, warning when
// it leaves auth out.
func (s *devSession) applyRules(f *devconfig.File, contract string, progress func(string)) error {
	if f == nil {
		s.reloader.SetRules(nil)
		return nil
	}
	rules, err := dev.RulesOf(f.Diff, contract)
	if err != nil {
		return &inputError{err.Error()}
	}
	if rules.IgnoreAuth {
		progress("warning: ignore_auth = true in signet.dev.toml: auth changes break signed payloads, and the diffs will not report them")
	}
	s.reloader.SetRules(rules)
	return nil
}
