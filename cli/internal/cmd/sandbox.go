package cmd

import (
	"strconv"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/rpc"
)

func init() {
	register(groupContracts, newSandboxCmd)
}

// newSandboxCmd is the parent of the commands that run a deployed contract
// locally (docs/CONTRACT_SANDBOX_DESIGN.md). It never needs the contract
// simulator itself: only a subcommand that executes contract code locates
// it, so `signet sandbox --help` works on a machine without one.
func newSandboxCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "sandbox",
		Short: "Run a deployed contract's functions locally against forked state",
		Long: `Run a deployed contract's functions locally, against a fork of the real
ledger pinned at one ledger sequence. Nothing is submitted to the network:
calls execute in the contract simulator (signet-simulator) that ships with
signet, and every result says which ledger it ran against.

The network comes from --network (testnet by default). Its RPC is --rpc-url,
then the context's rpc-url (signet config set rpc-url <url>), then, for
testnet only, https://soroban-testnet.stellar.org. Mainnet has no default.
Before forking, signet checks the RPC serves the selected network's
passphrase.

The simulator is found through SIGNET_SIMULATOR_PATH, then next to the signet
binary, then on PATH.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return cmd.Help()
		},
	}
	addRPCFlags(cmd)
	cmd.AddCommand(newSandboxForkCmd(), newSandboxForksCmd(), newSandboxCallCmd(), newSandboxSessionCmd(), newSandboxStateCmd(), newSandboxExportCmd(), newSandboxReplayCmd(), newSandboxFidelityCmd())
	return cmd
}

// addRPCFlags adds the RPC flags `sandbox` and `dev` share. --network itself
// is the root's persistent flag; these complete it for internal/rpc.Select.
func addRPCFlags(cmd *cobra.Command) {
	cmd.PersistentFlags().String("rpc-url", "", "Stellar RPC to fork from (overrides the context's rpc-url; testnet defaults to "+rpc.DefaultTestnetURL+")")
	cmd.PersistentFlags().String("network-passphrase", "", "passphrase of a custom --network (checked against the RPC's getNetwork)")
	cmd.PersistentFlags().String("drift", "warn", "when an entry fetched for the fork changed on-chain after the fork ledger: warn, fail (exit 6), or refork (pin the latest ledger and run once more)")
}

// driftMode reads --drift.
func driftMode(cmd *cobra.Command) (string, error) {
	mode, _ := cmd.Flags().GetString("drift")
	switch mode {
	case "warn", "fail", "refork":
		return mode, nil
	}
	return "", &inputError{"--drift must be warn, fail or refork, not " + strconv.Quote(mode)}
}
