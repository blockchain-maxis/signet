package cmd

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/fork"
	"github.com/blockchain-maxis/signet/cli/internal/rpc"
)

func newSandboxForksCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "forks",
		Short: "List, remove and refresh cached forks",
		Long: `List, remove and refresh the forks signet keeps under the user cache
directory. Forks pile up and go stale: each one is pinned at the ledger it was
made at.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return cmd.Help()
		},
	}
	cmd.AddCommand(newSandboxForksLsCmd(), newSandboxForksRmCmd(), newSandboxForksRefreshCmd())
	return cmd
}

func forkRoot(deps Deps) (string, error) {
	if deps.ForkRoot != nil {
		return deps.ForkRoot()
	}
	return fork.Root()
}

func now(deps Deps) time.Time {
	if deps.Now != nil {
		return deps.Now()
	}
	return time.Now()
}

// forkRow is one fork in `ls --json`.
type forkRow struct {
	fork.Info
	AgeSeconds int64 `json:"ageSeconds"`
}

func newSandboxForksLsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "ls",
		Short: "List cached forks with their age, size and drift",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
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
			at := now(deps)
			rows := make([]forkRow, len(forks))
			for i, f := range forks {
				rows[i] = forkRow{Info: f, AgeSeconds: int64(at.Sub(f.ForkTime).Seconds())}
			}
			return printerFor(cmd).Result(rows, func(w io.Writer) error {
				if len(rows) == 0 {
					_, err := fmt.Fprintln(w, "No forks. Make one with `signet sandbox fork <contract>`.")
					return err
				}
				tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
				_, _ = fmt.Fprintln(tw, "ID\tNETWORK\tLEDGER\tAGE\tENTRIES\tSIZE\tDRIFT")
				for _, r := range rows {
					entries := strconv.Itoa(r.Entries)
					if r.InUse {
						entries = "in use"
					}
					_, _ = fmt.Fprintf(tw, "%s\t%s\t%d\t%s\t%s\t%s\t%d\n",
						shorten(r.Contract, 4, 3)+"@"+strconv.FormatUint(uint64(r.ForkLedger), 10),
						r.Network, r.ForkLedger, strings.TrimSuffix(ago(at.Sub(r.ForkTime)), " ago"),
						entries, humanBytes(r.SizeBytes), r.DriftedEntries)
				}
				return tw.Flush()
			})
		},
	}
}

func humanBytes(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MiB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KiB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}

// parseAge reads --older-than: a Go duration (36h, 90m) or whole days or
// weeks (7d, 2w).
func parseAge(s string) (time.Duration, error) {
	s = strings.TrimSpace(s)
	for suffix, unit := range map[string]time.Duration{"d": 24 * time.Hour, "w": 7 * 24 * time.Hour} {
		if n, ok := strings.CutSuffix(s, suffix); ok {
			v, err := strconv.Atoi(n)
			if err != nil || v <= 0 {
				return 0, fmt.Errorf("--older-than %q: want a positive number of %s", s, map[string]string{"d": "days", "w": "weeks"}[suffix])
			}
			return time.Duration(v) * unit, nil
		}
	}
	d, err := time.ParseDuration(s)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("--older-than %q: want a duration like 7d, 2w or 36h", s)
	}
	return d, nil
}

type rmResult struct {
	Removed []string `json:"removed"`
}

func newSandboxForksRmCmd() *cobra.Command {
	var all, assumeYes bool
	var olderThan string
	cmd := &cobra.Command{
		Use:   "rm [<forkId>]",
		Short: "Remove a fork, every fork, or forks older than an age",
		Example: `  signet sandbox forks rm CASF…RCN@4887004
  signet sandbox forks rm --older-than 7d
  signet sandbox forks rm --all --yes`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			selectors := 0
			for _, set := range []bool{len(args) == 1, all, olderThan != ""} {
				if set {
					selectors++
				}
			}
			if selectors != 1 {
				return &inputError{"name one fork id, or pass --all or --older-than"}
			}
			var minAge time.Duration
			if olderThan != "" {
				if minAge, err = parseAge(olderThan); err != nil {
					return &inputError{err.Error()}
				}
			}
			root, err := forkRoot(deps)
			if err != nil {
				return err
			}
			forks, err := fork.List(root)
			if err != nil {
				return fmt.Errorf("%w: reading the fork cache: %v", exitcode.ErrConfiguration, err)
			}
			at := now(deps)
			var chosen []fork.Info
			for _, f := range forks {
				switch {
				case len(args) == 1 && (f.ID == args[0] || f.Dir == args[0]):
					chosen = append(chosen, f)
				case all:
					chosen = append(chosen, f)
				case olderThan != "" && at.Sub(f.ForkTime) > minAge:
					chosen = append(chosen, f)
				}
			}
			if len(args) == 1 && len(chosen) == 0 {
				return &inputError{fmt.Sprintf("no fork %q; `signet sandbox forks ls` lists them", args[0])}
			}

			printer := printerFor(cmd)
			// Removing many forks at once asks first, and needs --yes when
			// nobody is there to answer.
			if (all || olderThan != "") && len(chosen) > 0 && !assumeYes {
				if !stdinIsTerminal(cmd.InOrStdin()) {
					return &inputError{"removing several forks needs --yes when not run interactively"}
				}
				if _, err := fmt.Fprintf(printer.Interactive(), "Remove %d fork(s)? [y/N] ", len(chosen)); err != nil {
					return err
				}
				scanner := bufio.NewScanner(cmd.InOrStdin())
				answer := ""
				if scanner.Scan() {
					answer = strings.ToLower(strings.TrimSpace(scanner.Text()))
				}
				if answer != "y" && answer != "yes" {
					return printer.Result(rmResult{Removed: []string{}}, func(w io.Writer) error {
						_, err := fmt.Fprintln(w, "Nothing removed.")
						return err
					})
				}
			}

			res := rmResult{Removed: []string{}}
			for _, f := range chosen {
				if err := fork.Remove(f); err != nil {
					return err
				}
				res.Removed = append(res.Removed, f.ID)
			}
			return printer.Result(res, func(w io.Writer) error {
				if len(res.Removed) == 0 {
					_, err := fmt.Fprintln(w, "No forks matched.")
					return err
				}
				for _, id := range res.Removed {
					if _, err := fmt.Fprintf(w, "Removed %s\n", id); err != nil {
						return err
					}
				}
				return nil
			})
		},
	}
	cmd.Flags().BoolVar(&all, "all", false, "remove every fork")
	cmd.Flags().StringVar(&olderThan, "older-than", "", "remove forks pinned longer ago than this (7d, 2w, 36h)")
	cmd.Flags().BoolVar(&assumeYes, "yes", false, "skip the confirmation prompt")
	return cmd
}

func newSandboxForksRefreshCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "refresh <forkId>",
		Short: "Fork the same contract again at the latest ledger",
		Long: `Fork the same contract again, on the same network and RPC, at the latest
ledger. The old fork stays until you remove it. Saved calls live in
signet.dev.toml, not in the fork, so they carry over.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			mode, err := driftMode(cmd)
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
			var old *fork.Info
			for i := range forks {
				if forks[i].ID == args[0] {
					old = &forks[i]
				}
			}
			if old == nil {
				return &inputError{fmt.Sprintf("no fork %q; `signet sandbox forks ls` lists them", args[0])}
			}
			network := rpc.Network{Name: old.Network, Passphrase: old.Passphrase, RPCURL: old.RPCURL}
			if u, _ := cmd.Flags().GetString("rpc-url"); u != "" {
				network.RPCURL = u
			}
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt)
			defer stop()
			printer := printerFor(cmd)
			m, err := forkWithDrift(ctx, deps, network, old.Contract, mode, printer.Progress)
			if err != nil {
				return err
			}
			return printer.Result(m, func(w io.Writer) error {
				_, err := fmt.Fprintln(w, describeFork(m, now(deps)))
				return err
			})
		},
	}
}
