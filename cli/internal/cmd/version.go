package cmd

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"
)

func init() { register(groupOther, newVersionCmd) }

// versionResult is the --json shape of `signet version`.
type versionResult struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
}

// newVersionCmd is `signet --version` as a command, so it can sit in the
// "Other" group and honour --json like everything else.
func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the signet version",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			return printerFor(cmd).Result(
				versionResult{Version: deps.Version, Commit: deps.Commit},
				func(w io.Writer) error {
					_, err := fmt.Fprintf(w, "signet version %s (commit %s)\n", deps.Version, deps.Commit)
					return err
				},
			)
		},
	}
}
