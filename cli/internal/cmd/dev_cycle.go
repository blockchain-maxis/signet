package cmd

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/blockchain-maxis/signet/cli/internal/dev"
	"github.com/blockchain-maxis/signet/cli/internal/devconfig"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/fork"
	"github.com/blockchain-maxis/signet/cli/internal/rpc"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// devSession is the warm simulator session signet dev's cycles run in
// (#566): the fork open in the host and the reloader's base taken.
type devSession struct {
	reloader *dev.Reloader
	cache    *fork.Cache
}

func (s *devSession) Close() {
	if s.cache != nil {
		_ = s.cache.Close()
	}
}

// openDevSession opens the fork of contract in sim, answering its fetches
// from the fork cache and the RPC, and takes the reloader's base.
func openDevSession(ctx context.Context, deps Deps, network rpc.Network, client *rpc.Client, sim *simulator.Client, m fork.Manifest) (*devSession, error) {
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
	s := &devSession{cache: cache}
	sim.HandleFetch((&fork.Fetcher{Ctx: ctx, Cache: cache, RPC: client, ForkLedger: m.ForkLedger}).Fetch)
	protocol, sequence, timestamp := m.Protocol, m.ForkLedger, uint64(m.ForkTime.Unix())
	if _, err := callSimulator(ctx, sim, simulator.TypeLedgerOpen, simulator.LedgerOpenParams{
		NetworkPassphrase: m.Passphrase, LedgerProtocol: &protocol, Sequence: &sequence, Timestamp: &timestamp,
		SessionID: "signet-dev",
	}, nil); err != nil {
		s.Close()
		return nil, err
	}
	if s.reloader, err = dev.NewReloader(ctx, sim, m.Contract); err != nil {
		s.Close()
		return nil, fmt.Errorf("%w: %v", exitcode.ErrSimulator, err)
	}
	return s, nil
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
		out[i] = dev.Replay{Name: name, Params: simulator.SimulateParams{Function: c.Function, Args: args}}
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
		mark := "="
		if o.Diff != nil && !o.Diff.Empty {
			mark = "≠"
		}
		lines = append(lines, fmt.Sprintf("  %s  A %s  %s  B %s", o.Name, a, mark, b))
	}
	return lines
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
