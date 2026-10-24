package cmd

import (
	"github.com/spf13/cobra"
)

func init() {
	register(groupContracts, newSandboxCmd)
}

// newSandboxCmd is the parent of the commands that run a deployed contract
// locally (docs/CONTRACT_SANDBOX_DESIGN.md). It never needs the contract
// simulator itself: only a subcommand that executes contract code locates
// it, so `signet sandbox --help` works on a machine without one.
func newSandboxCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "sandbox",
		Short: "Run a deployed contract's functions locally against forked state",
		Long: `Run a deployed contract's functions locally, against a fork of the real
ledger pinned at one ledger sequence. Nothing is submitted to the network:
calls execute in the contract simulator (signet-simulator) that ships with
signet, and every result says which ledger it ran against.

The simulator is found through SIGNET_SIMULATOR_PATH, then next to the signet
binary, then on PATH.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return cmd.Help()
		},
	}
}
