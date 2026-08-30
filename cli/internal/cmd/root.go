// Package cmd wires up the signet CLI's command tree with Cobra. Subcommands
// that talk to a wallet, a keyring, or a Signet deployment live in their own
// internal packages (link, keys, spec) and are attached here as they land.
package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

func newRootCmd(version, commit string) *cobra.Command {
	root := &cobra.Command{
		Use:   "signet",
		Short: "Link wallets and manage identity on the Signet registry",
		Long: `signet is the command-line companion to the Signet developer identity
registry on Stellar/Soroban.

It links a local wallet to an on-chain handle, manages signing keys, and
talks to a Signet deployment (the default hosted one, or a self-hosted
instance) over its HTTP API.`,
		SilenceUsage:  true,
		SilenceErrors: true,
	}

	// Cobra only renders the "Usage:" section of --help (and of a bare
	// invocation) when the command is Runnable() or has subcommands — neither
	// is true yet for a fresh scaffold with no subcommands attached. Giving it
	// a RunE that just prints help keeps `signet` and `signet --help` both
	// showing real usage instead of only the Long description.
	root.RunE = func(cmd *cobra.Command, _ []string) error {
		return cmd.Help()
	}

	// Cobra wires --version to this automatically once Version is non-empty.
	root.Version = fmt.Sprintf("%s (commit %s)", version, commit)
	root.SetVersionTemplate("signet version {{.Version}}\n")

	return root
}

// Execute builds the command tree and runs it against the process's
// arguments. main() only needs to report the error and set an exit code.
func Execute(version, commit string) error {
	return newRootCmd(version, commit).Execute()
}
