package cmd

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/bundle"
	"github.com/blockchain-maxis/signet/cli/internal/devconfig"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/fork"
)

// newSandboxExportCmd is `signet sandbox export` (#572): a signet dev
// session as a repro bundle.
func newSandboxExportCmd() *cobra.Command {
	var session, output, maxSize string
	cmd := &cobra.Command{
		Use:   "export -o <file>",
		Short: "Write a signet dev session as a repro bundle",
		Long: `Write a signet dev session as a repro bundle: one JSON file someone else
can re-run offline and get the same results from. It holds the network and
fork, every ledger entry a call's footprint read, the network config, the
deployed and the built WASM, the last cycle's calls, overrides and results,
and a bundleHash over its canonical JSON, so exporting the same session twice
gives the same file.

The session is the newest log under .signet/sessions next to signet.dev.toml
(or in the working directory), or --session. A bundle over --max-size is
refused with what takes the room.

Fork data is public chain state, but overrides and saved-call arguments are
whatever was typed: read the bundle before sharing it.`,
		Example: `  signet sandbox export -o repro.json
  signet sandbox export --session .signet/sessions/20261025T120000.000Z.ndjson -o repro.json --max-size 50MB`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			if output == "" {
				return &inputError{"signet sandbox export needs -o <file>"}
			}
			max, err := parseSize(maxSize)
			if err != nil {
				return &inputError{fmt.Sprintf("--max-size: %v", err)}
			}
			printer := printerFor(cmd)
			if session == "" {
				cwd, err := os.Getwd()
				if err != nil {
					return err
				}
				dir := cwd
				if found := devconfig.Find(cwd); found != "" {
					dir = filepath.Dir(found)
				}
				if session, err = bundle.Latest(dir); err != nil {
					return fmt.Errorf("%w: %v", exitcode.ErrConfiguration, err)
				}
				if session == "" {
					return &inputError{fmt.Sprintf("no signet dev session under %s: run signet dev first", filepath.Join(dir, filepath.FromSlash(bundle.SessionsDir)))}
				}
			}
			s, builds, cycles, err := bundle.Read(session)
			if err != nil {
				return &inputError{err.Error()}
			}
			root, err := forkRoot(deps)
			if err != nil {
				return err
			}
			cache, err := fork.Open(root, s.Network.Passphrase, s.Fork.ID)
			if err != nil {
				return fmt.Errorf("%w: the session's fork %s: %v", exitcode.ErrConfiguration, s.Fork.ID, err)
			}
			entries, err := cache.Entries()
			_ = cache.Close()
			if err != nil {
				return err
			}
			b, err := bundle.Build(s, builds, cycles, entries)
			if err != nil {
				return &inputError{err.Error()}
			}
			out, err := bundle.Encode(b, max)
			if err != nil {
				return &inputError{err.Error()}
			}
			if err := os.WriteFile(output, out, 0o644); err != nil {
				return fmt.Errorf("%w: %v", exitcode.ErrConfiguration, err)
			}
			printer.Progress("Note: fork data is public chain state, but the overrides and saved-call arguments in the bundle are whatever was typed. Read it before sharing.")
			result := struct {
				Path       string `json:"path"`
				BundleHash string `json:"bundleHash"`
				Bytes      int    `json:"bytes"`
				Entries    int    `json:"entries"`
				Calls      int    `json:"calls"`
			}{output, b.BundleHash, len(out), len(b.Entries), len(b.Calls)}
			return printer.Result(result, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "Wrote %s (%d bytes): %d %s, %d %s, bundleHash %s\n", output, len(out),
					len(b.Entries), plural(len(b.Entries), "entry", "entries"), len(b.Calls), plural(len(b.Calls), "call", "calls"), b.BundleHash)
				return err
			})
		},
	}
	cmd.Flags().StringVar(&session, "session", "", "the session log to export (default: the newest)")
	cmd.Flags().StringVarP(&output, "output", "o", "", "the bundle file to write")
	cmd.Flags().StringVar(&maxSize, "max-size", "25MB", "refuse a bundle larger than this (bytes, or with KB or MB)")
	return cmd
}

// parseSize reads "25MB", "512KB" or a byte count.
func parseSize(s string) (int, error) {
	t := strings.ToUpper(strings.TrimSpace(s))
	unit := 1
	switch {
	case strings.HasSuffix(t, "MB"):
		unit, t = 1<<20, strings.TrimSuffix(t, "MB")
	case strings.HasSuffix(t, "KB"):
		unit, t = 1<<10, strings.TrimSuffix(t, "KB")
	case strings.HasSuffix(t, "B"):
		t = strings.TrimSuffix(t, "B")
	}
	n, err := strconv.Atoi(strings.TrimSpace(t))
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%q is not a size like 25MB", s)
	}
	return n * unit, nil
}
