package cmd

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/link"
)

func newLinkCmd() *cobra.Command {
	var publicKey string
	var network string
	var jsonOutput bool

	cmd := &cobra.Command{
		Use:   "link <handle>",
		Short: "Attach a wallet to a Signet handle",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			result, err := link.Link(args[0], publicKey, network)
			if err != nil {
				return err
			}

			// --json commits to exactly one JSON object on stdout and
			// nothing else, so CI pipelines that parse the result don't
			// have to scrape human-formatted text that's free to change
			// between releases. Any decorative/human text is suppressed
			// here rather than sent to stdout; an error from link.Link
			// above still reaches the user, but on stderr — main.go prints
			// RunE's returned error there, never to stdout.
			if jsonOutput {
				return json.NewEncoder(cmd.OutOrStdout()).Encode(result)
			}

			// Deliberately not "Linked …": internal/keys and internal/spec
			// are still scaffolds, so nothing has been claimed on-chain or
			// sent to a deployment yet. Saying otherwise would report a
			// success that did not happen.
			_, err = fmt.Fprintf(
				cmd.OutOrStdout(),
				"Validated %s for %s (%s). Not yet submitted — the on-chain claim is not implemented.\n",
				result.Handle, result.PublicKey, result.Network,
			)
			return err
		},
	}

	cmd.Flags().StringVar(&publicKey, "public-key", "", "the wallet's Stellar public key (G...)")
	cmd.Flags().StringVar(&network, "network", "testnet", "Stellar network")
	cmd.Flags().BoolVar(&jsonOutput, "json", false, "write a single JSON result to stdout instead of a human-readable summary")

	return cmd
}
