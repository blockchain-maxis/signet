package cmd

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"

	updatecheck "github.com/blockchain-maxis/signet/cli/internal/update"
)

func init() { register(groupOther, newVersionCmd) }

// versionResult is the --json shape of `signet version`.
type versionResult struct {
	Version         string `json:"version"`
	Commit          string `json:"commit"`
	Latest          string `json:"latest,omitempty"`
	UpdateAvailable *bool  `json:"updateAvailable,omitempty"`
}

// newVersionCmd is `signet --version` as a command, so it can sit in the
// "Other" group and honour --json like everything else.
func newVersionCmd() *cobra.Command {
	var check bool
	cmd := &cobra.Command{
		Use:   "version",
		Short: "Print the signet version",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			printer := printerFor(cmd)

			if !check {
				return printer.Result(
					versionResult{Version: deps.Version, Commit: deps.Commit},
					func(w io.Writer) error {
						_, err := fmt.Fprintf(w, "signet version %s (commit %s)\n", deps.Version, deps.Commit)
						return err
					},
				)
			}

			var res *updatecheck.CheckResult
			if deps.CheckUpdate != nil {
				res, err = deps.CheckUpdate(cmd.Context(), deps.Version)
			} else {
				dir, _ := cacheDir()
				res, err = updatecheck.Check(cmd.Context(), deps.Version, updatecheck.Options{
					CacheDir: dir,
				})
			}

			if err != nil {
				printer.Diagnostic(fmt.Sprintf("warning: failed to check for updates: %v", err))
				return printer.Result(
					versionResult{Version: deps.Version, Commit: deps.Commit},
					func(w io.Writer) error {
						_, err := fmt.Fprintf(w, "signet version %s (commit %s)\n", deps.Version, deps.Commit)
						return err
					},
				)
			}

			avail := res.UpdateAvailable
			return printer.Result(
				versionResult{
					Version:         deps.Version,
					Commit:          deps.Commit,
					Latest:          res.Latest,
					UpdateAvailable: &avail,
				},
				func(w io.Writer) error {
					if _, err := fmt.Fprintf(w, "signet version %s (commit %s)\n", deps.Version, deps.Commit); err != nil {
						return err
					}
					if _, err := fmt.Fprintf(w, "Latest release: %s\n", res.Latest); err != nil {
						return err
					}
					if res.UpdateAvailable {
						_, err = fmt.Fprintf(w, "Upgrade: %s\n", res.UpgradeCommand)
						return err
					}
					_, err = fmt.Fprintln(w, "signet is up to date.")
					return err
				},
			)
		},
	}
	cmd.Flags().BoolVar(&check, "check", false, "check for newer signet releases")
	return cmd
}
