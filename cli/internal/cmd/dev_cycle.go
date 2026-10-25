package cmd

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"strings"

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
	s := &devSession{cache: cache, sim: sim, manifest: m}
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
		SessionID: "signet-dev",
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
	return cycle, nil
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
