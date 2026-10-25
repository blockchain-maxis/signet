package cmd

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/bundle"
	"github.com/blockchain-maxis/signet/cli/internal/dev"
	"github.com/blockchain-maxis/signet/cli/internal/devconfig"
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
func (s *devSession) runCycle(ctx context.Context, wasmPath string, replays []dev.Replay, progress func(string)) (dev.Cycle, error) {
	wasm, err := os.ReadFile(wasmPath)
	if err != nil {
		return dev.Cycle{}, fmt.Errorf("%w: reading the build: %v", exitcode.ErrConfiguration, err)
	}
	cycle, err := s.reloader.Cycle(ctx, wasm, replays)
	if err != nil {
		return dev.Cycle{}, fmt.Errorf("%w: %v", exitcode.ErrSimulator, err)
	}
	for _, line := range describeCycle(cycle) {
		progress(line)
	}
	if s.log != nil {
		if err := s.log.Cycle(wasm, cycleRecord(cycle, replays, s.overrides), time.Now()); err != nil {
			progress("warning: the session log could not be written: " + err.Error())
		}
	}
	return cycle, nil
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
		out.Calls = append(out.Calls, bundle.Call{Name: r.Name, Function: r.Params.Function, Args: args, Chain: r.Chain, Expect: string(expect), Source: "saved"})
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

// describeCycle is the cycle in lines, until the diff renderers (#568,
// #637) say more: what each call returned on each side.
func describeCycle(c dev.Cycle) []string {
	head := fmt.Sprintf("replayed %d saved %s on %s (deployed) and %s (build): %d %s",
		len(c.Outcomes), plural(len(c.Outcomes), "call", "calls"), shortHash(c.Deployed), shortHash(c.Local),
		c.Simulations, plural(c.Simulations, "run", "runs"))
	for _, reason := range c.Restarted {
		head += fmt.Sprintf(" · simulator restarted (%s)", reason)
	}
	lines := []string{head}
	if s := c.Spec; s != nil && len(s.Changes) > 0 {
		lines = append(lines, fmt.Sprintf("  interface: %d breaking, %d compatible, %d info", s.Summary.Breaking, s.Summary.Compatible, s.Summary.Info))
		for _, ch := range s.Changes {
			if ch.Class == simulator.ClassBreaking {
				lines = append(lines, fmt.Sprintf("    %s %s", ch.Kind, ch.Path))
			}
		}
	}
	if l := c.Layout; l != nil && len(l.Findings) > 0 {
		lines = append(lines, fmt.Sprintf("  storage layout: %d stored %s the build cannot read", len(l.Findings), plural(len(l.Findings), "value", "values")))
		for _, f := range l.Findings {
			lines = append(lines, fmt.Sprintf("    %s %s (%s, %s): %s", f.Key, f.DecodedKey, f.UDT, f.Evidence, f.Reason))
		}
	}
	if len(c.Outcomes) == 0 {
		lines = append(lines, "  no saved calls: add some with signet sandbox call … --save")
	}
	for _, o := range c.Outcomes {
		a, b := describeRun(o.A), describeRun(o.B)
		mark, classes := "=", ""
		if o.Diff != nil && !o.Diff.Summary.Clean() {
			mark, classes = "≠", "  ("+describeSummary(o.Diff.Summary)+")"
		}
		check := ""
		switch v := o.Verdict; {
		case v == nil:
		case v.Pass:
			check = "  ✓ " + v.Expect
		default:
			check = fmt.Sprintf("  ✗ expected %s: %s", v.Expect, v.Reason)
		}
		lines = append(lines, fmt.Sprintf("  %s  A %s  %s  B %s%s%s", o.Name, a, mark, b, classes, check))
	}
	return lines
}

// describeSummary names the classes found: "1 breaking, 2 cost".
func describeSummary(s simulator.DiffSummary) string {
	var parts []string
	for _, c := range []struct {
		n    int
		name string
	}{{s.Breaking, "breaking"}, {s.Behavioural, "behavioural"}, {s.Cost, "cost"}, {s.Ignored, "ignored"}} {
		if c.n > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", c.n, c.name))
		}
	}
	return strings.Join(parts, ", ")
}

// applyFile hands signet.dev.toml to the session: its [diff] rules, and
// its overrides, starting the session over when they changed.
func (s *devSession) applyFile(ctx context.Context, f *devconfig.File, contract string, progress func(string)) error {
	if overrides := fileOverrides(f); !reflect.DeepEqual(overrides, s.overrides) {
		if err := s.reset(ctx, overrides); err != nil {
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

func describeRun(r dev.Run) string {
	switch {
	case r.Error != nil && r.Error.Decoded != nil && r.Error.Decoded.ErrorName != "":
		return "error " + r.Error.Decoded.ErrorName
	case r.Error != nil:
		return "error " + r.Error.Code
	case r.Result != nil && len(r.Result.ReturnValue) > 0:
		return strings.TrimSpace(string(r.Result.ReturnValue))
	case r.Result != nil:
		return r.Result.ReturnValueXDR
	}
	return "?"
}

func shortHash(h string) string {
	if len(h) > 8 {
		return h[:8]
	}
	return h
}
