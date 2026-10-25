package cmd

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/bundle"
	"github.com/blockchain-maxis/signet/cli/internal/dev"
	"github.com/blockchain-maxis/signet/cli/internal/devconfig"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// newSandboxReplayCmd is `signet sandbox replay` (#573): a repro bundle run
// offline, compared with what it recorded.
func newSandboxReplayCmd() *cobra.Command {
	var wasmPath, stream string
	cmd := &cobra.Command{
		Use:   "replay <bundle.json>",
		Short: "Re-run a repro bundle offline and compare with what it recorded",
		Long: `Re-run a repro bundle (signet sandbox export) with no network access: the
host is opened with fetching denied, loaded with the bundle's entries, network
config and overrides, and every call runs on the deployed and the built WASM
from the same state, as signet dev ran it. Each side's outcome and return value
must match the bundle's expected results; any mismatch exits 10.

--wasm replaces the built WASM, to try a fix against someone's repro (the
expected results are then the old build's, so a changed call is a mismatch).
A bundle recorded on a simulator lane this build does not have exits 11, and
an edited bundle (its bundleHash no longer matches) exits 2.

--stream writes every call's full A and B results as NDJSON: the same bundle
gives the same bytes on every platform, which CI checks.`,
		Example: `  signet sandbox replay repro.json
  signet sandbox replay repro.json --wasm target/wasm32v1-none/release/registry.wasm`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			raw, err := os.ReadFile(args[0])
			if err != nil {
				return &inputError{err.Error()}
			}
			var b bundle.Bundle
			if err := json.Unmarshal(raw, &b); err != nil {
				return &inputError{fmt.Sprintf("%s is not a repro bundle: %v", args[0], err)}
			}
			if b.Version != bundle.Version {
				return &inputError{fmt.Sprintf("%s is bundle version %d; this signet reads version %d", args[0], b.Version, bundle.Version)}
			}
			if hash, err := bundle.Hash(&b); err != nil || hash != b.BundleHash {
				return &inputError{fmt.Sprintf("%s has been edited: its bundleHash %s does not match its content (%s)", args[0], b.BundleHash, hash)}
			}
			local, err := base64.StdEncoding.DecodeString(b.Wasm.Local.Base64)
			if err != nil {
				return &inputError{"wasm.local is not base64"}
			}
			if wasmPath != "" {
				if local, err = os.ReadFile(wasmPath); err != nil {
					return &inputError{fmt.Sprintf("--wasm: %v", err)}
				}
			}
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt)
			defer stop()
			printer := printerFor(cmd)

			sim, err := startSimulator(ctx, deps, printer.Progress)
			if err != nil {
				return err
			}
			defer func() { _ = sim.Close() }()
			if err := requireLane(sim.HelloAck(), b.Simulator.Lane); err != nil {
				return err
			}
			cycle, err := replayBundle(ctx, sim, &b, local)
			if err != nil {
				return err
			}
			if stream != "" {
				if err := writeStream(stream, cycle); err != nil {
					return fmt.Errorf("%w: --stream: %v", exitcode.ErrConfiguration, err)
				}
			}

			type check struct {
				Name   string         `json:"name"`
				Match  bool           `json:"match"`
				Got    [2]bundle.Side `json:"got"`
				Wanted [2]bundle.Side `json:"wanted"`
			}
			var checks []check
			var mismatched []string
			for i, o := range cycle.Outcomes {
				c := check{Name: o.Name, Got: [2]bundle.Side{bundleSide(o.A), bundleSide(o.B)}}
				if i < len(b.Expected) {
					c.Wanted = [2]bundle.Side{b.Expected[i].A, b.Expected[i].B}
				}
				c.Match = c.Got == c.Wanted
				if !c.Match {
					mismatched = append(mismatched, o.Name)
				}
				checks = append(checks, c)
			}
			result := struct {
				Bundle     string  `json:"bundle"`
				BundleHash string  `json:"bundleHash"`
				Calls      []check `json:"calls"`
				Match      bool    `json:"match"`
			}{args[0], b.BundleHash, checks, len(mismatched) == 0}
			if err := printer.Result(result, func(w io.Writer) error {
				for _, c := range checks {
					mark := "✓"
					if !c.Match {
						mark = fmt.Sprintf("✗ expected A %s, B %s", describeSide(c.Wanted[0]), describeSide(c.Wanted[1]))
					}
					if _, err := fmt.Fprintf(w, "  %s  A %s  B %s  %s\n", c.Name, describeSide(c.Got[0]), describeSide(c.Got[1]), mark); err != nil {
						return err
					}
				}
				return nil
			}); err != nil {
				return err
			}
			if len(mismatched) > 0 {
				return fmt.Errorf("%w: %d of %d calls do not match the bundle: %s", exitcode.ErrDiffFound, len(mismatched), len(checks), strings.Join(mismatched, ", "))
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&wasmPath, "wasm", "", "a WASM to run as the build instead of the bundle's")
	cmd.Flags().StringVar(&stream, "stream", "", "write every call's full A and B results here, as NDJSON")
	return cmd
}

// requireLane refuses a bundle recorded on a lane this simulator lacks.
func requireLane(ack simulator.HelloAck, lane int) error {
	var have []string
	for _, l := range ack.Lanes {
		if l.LedgerProtocol == lane {
			return nil
		}
		have = append(have, fmt.Sprintf("p%d", l.LedgerProtocol))
	}
	return fmt.Errorf("%w: the bundle was recorded on lane p%d, which this signet-simulator does not run (it runs %s)", exitcode.ErrHostUnsupported, lane, strings.Join(have, ", "))
}

// replayBundle opens the bundle's ledger with fetching denied, applies its
// overrides, and runs its calls through the reload cycle on local.
func replayBundle(ctx context.Context, sim *simulator.Client, b *bundle.Bundle, local []byte) (dev.Cycle, error) {
	var entries []simulator.PutEntry
	for _, e := range append(append([]bundle.Entry{}, b.ConfigSettings...), b.Entries...) {
		seq := e.LastModifiedLedgerSeq
		entries = append(entries, simulator.PutEntry{KeyXDR: e.Key, DataXDR: e.Entry, ExtXDR: e.Ext, LastModifiedLedgerSeq: &seq, LiveUntilLedger: e.LiveUntil})
	}
	protocol, sequence, timestamp := b.Simulator.Lane, b.LedgerInfo.Sequence, b.LedgerInfo.Timestamp
	if _, err := callSimulator(ctx, sim, simulator.TypeLedgerOpen, simulator.LedgerOpenParams{
		NetworkPassphrase: b.Network.Passphrase, LedgerProtocol: &protocol, Sequence: &sequence, Timestamp: &timestamp,
		Fetch: "deny", Entries: entries, SessionID: devSessionID,
	}, nil); err != nil {
		return dev.Cycle{}, err
	}
	for i, o := range b.Overrides {
		if _, err := callSimulator(ctx, sim, simulator.TypeStorageOverride, simulator.StorageOverrideParams{
			ContractID: b.Fork.Contract, Durability: o.Durability, Key: o.Key, Value: o.Value, Unset: o.Unset,
		}, nil); err != nil {
			return dev.Cycle{}, asInputError(err, fmt.Sprintf("the bundle's override %d", i+1))
		}
	}
	reloader, err := dev.NewReloader(ctx, sim, b.Fork.Contract)
	if err != nil {
		return dev.Cycle{}, fmt.Errorf("%w: %v", exitcode.ErrSimulator, err)
	}
	replays := make([]dev.Replay, len(b.Calls))
	for i, c := range b.Calls {
		replays[i] = dev.Replay{Name: c.Name, Params: simulator.SimulateParams{Function: c.Function, Args: c.Args}, Chain: c.Chain}
		if c.Expect != "" {
			var e devconfig.Expect
			if err := e.UnmarshalText([]byte(c.Expect)); err != nil {
				return dev.Cycle{}, &inputError{fmt.Sprintf("call %q: %v", c.Name, err)}
			}
			replays[i].Expect = e
		}
	}
	cycle, err := reloader.Cycle(ctx, local, replays)
	if err != nil {
		return dev.Cycle{}, fmt.Errorf("%w: %v", exitcode.ErrSimulator, err)
	}
	return cycle, nil
}

// writeStream writes each outcome, in full, as one JSON line.
func writeStream(path string, c dev.Cycle) error {
	var b strings.Builder
	for _, o := range c.Outcomes {
		line, err := json.Marshal(o)
		if err != nil {
			return err
		}
		b.Write(line)
		b.WriteByte('\n')
	}
	return os.WriteFile(path, []byte(b.String()), 0o644)
}

func describeSide(s bundle.Side) string {
	if s.Outcome == "error" {
		return "error " + s.Error
	}
	return s.ReturnValueXDR
}
