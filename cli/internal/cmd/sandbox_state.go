package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/fork"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// StateResult is `signet sandbox state --json` (#554).
type StateResult struct {
	ForkID     string `json:"forkId"`
	Contract   string `json:"contract"`
	ForkLedger uint32 `json:"forkLedger"`
	// Complete is true for a consistent (archive) fork, which holds every
	// entry of the contract; a lazy fork knows only the keys something read.
	Complete bool         `json:"complete"`
	Entries  []StateEntry `json:"entries"`
}

// StateEntry is one storage entry: instance, persistent or temporary.
type StateEntry struct {
	Durability string          `json:"durability"`
	Key        json.RawMessage `json:"key"`
	Value      json.RawMessage `json:"value"`
}

func newSandboxStateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "state <fork-id>",
		Short: "List a fork's storage entries for its contract",
		Long: `List the storage of a fork's contract: its instance storage and its
persistent and temporary entries, keys and values decoded without a spec.

A fork made with --archive holds every entry of the contract at its ledger,
so the list is the contract's whole storage. A lazy fork holds only the keys
something has read, and says so. The fork id is what signet sandbox forks ls
prints (<contract>@<ledger>).`,
		Example: `  signet sandbox state CASF…RCN@4887004`,
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			root, err := forkRoot(deps)
			if err != nil {
				return err
			}
			forks, err := fork.List(root)
			if err != nil {
				return fmt.Errorf("%w: reading the fork cache: %v", exitcode.ErrConfiguration, err)
			}
			var info *fork.Info
			for i := range forks {
				if forks[i].ID == args[0] {
					info = &forks[i]
				}
			}
			if info == nil {
				return &inputError{fmt.Sprintf("no fork %q; signet sandbox forks ls lists them", args[0])}
			}
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt)
			defer stop()
			printer := printerFor(cmd)

			cache, err := fork.Open(root, info.Passphrase, info.ID)
			if err != nil {
				return err
			}
			entries, err := cache.Entries()
			_ = cache.Close()
			if err != nil {
				return err
			}
			params := simulator.EntriesDescribeParams{LedgerProtocol: &info.Protocol}
			for _, e := range entries {
				params.Entries = append(params.Entries, simulator.DescribeEntry{
					DataXDR: e.XDR, LastModifiedLedgerSeq: e.LastModifiedLedgerSeq, ExtXDR: e.ExtXDR,
				})
			}
			res := StateResult{ForkID: info.ID, Contract: info.Contract, ForkLedger: info.ForkLedger, Complete: info.Consistent, Entries: []StateEntry{}}
			if len(params.Entries) > 0 {
				sim, err := startSimulator(ctx, deps, printer.Progress)
				if err != nil {
					return err
				}
				defer func() { _ = sim.Close() }()
				var described simulator.EntriesDescribeResult
				if _, err := callSimulator(ctx, sim, simulator.TypeEntriesDescribe, params, &described); err != nil {
					return err
				}
				res.Entries = storageOf(info.Contract, described.Entries)
			}
			return printer.Result(res, func(w io.Writer) error { return writeState(w, res) })
		},
	}
}

// storageOf is the contract's own storage among a fork's entries: its
// instance storage map, then its persistent and temporary data.
func storageOf(contract string, entries []simulator.DescribedEntry) []StateEntry {
	var instance, data []StateEntry
	for _, e := range entries {
		if e.Contract != contract {
			continue
		}
		switch e.Kind {
		case "instance":
			for _, item := range e.Storage {
				instance = append(instance, StateEntry{Durability: "instance", Key: item.Key, Value: item.Value})
			}
		case "contract_data":
			data = append(data, StateEntry{Durability: e.Durability, Key: e.Key, Value: e.Value})
		}
	}
	return append(append([]StateEntry{}, instance...), data...)
}

func writeState(w io.Writer, res StateResult) error {
	var b strings.Builder
	if res.Complete {
		fmt.Fprintf(&b, "%s at ledger %d: complete storage, from a history-archive snapshot (%d %s)\n",
			shorten(res.Contract, 4, 3), res.ForkLedger, len(res.Entries), entriesNoun(len(res.Entries)))
	} else {
		fmt.Fprintf(&b, "%s at ledger %d: known keys (%d) — this is not the full storage\n",
			shorten(res.Contract, 4, 3), res.ForkLedger, len(res.Entries))
	}
	for _, e := range res.Entries {
		fmt.Fprintf(&b, "  %-10s %s = %s\n", e.Durability, e.Key, e.Value)
	}
	if !res.Complete {
		b.WriteString("A lazy fork holds only what something read; signet sandbox fork --archive takes it all.\n")
	}
	_, err := io.WriteString(w, b.String())
	return err
}

func entriesNoun(n int) string {
	if n == 1 {
		return "entry"
	}
	return "entries"
}
