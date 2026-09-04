package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/browser"
	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/link"
	"github.com/blockchain-maxis/signet/cli/internal/loopback"
	"github.com/blockchain-maxis/signet/cli/internal/pair"
)

// newLinkCmd wires the pairing flow to the real world: the `stellar` CLI for
// identity and signing, a loopback listener for the callback, a browser, and
// the deployment's HTTP API. internal/link owns the sequencing; everything
// here is the plumbing it is given.
//
// The handle is not an argument. It is whichever handle the developer is
// signed in as when they approve in the browser — asking for it here would
// invite typing one you do not own, and the server would refuse it anyway.
func newLinkCmd() *cobra.Command {
	var network string
	var jsonOutput bool
	var noBrowser bool

	cmd := &cobra.Command{
		Use:   "link",
		Short: "Attach this machine's deploy wallet to your Signet handle",
		Long: `Links the wallet you deploy contracts from to your Signet handle.

signet prints a URL to approve in your browser. Approving it proves you own
the handle; signing a challenge with your local identity proves you control
the deploy key. Both are required, and signet never reads your secret key —
signing goes through the stellar CLI.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			resolved, ok := config.FromContext(cmd.Context())
			if !ok {
				return fmt.Errorf("%w: configuration was not resolved", exitcode.ErrConfiguration)
			}

			source, err := keys.Resolve(
				keys.DefaultBinary,
				resolved.Source,
				promptForIdentity(cmd.InOrStdin(), cmd.OutOrStdout()),
			)
			if err != nil {
				return err
			}
			publicKey, err := keys.ResolvePublicKey(keys.DefaultBinary, source)
			if err != nil {
				return err
			}
			if err := link.ValidatePublicKey(publicKey); err != nil {
				return err
			}

			client := pair.New(resolved.BaseURL)
			// --json promises exactly one JSON object on stdout, so progress
			// has to go to stderr in that mode or it would corrupt the output
			// a CI pipeline is parsing.
			progress := cmd.OutOrStdout()
			if jsonOutput {
				progress = cmd.ErrOrStderr()
			}

			result, err := link.Run(cmd.Context(), resolved.BaseURL, network, source, publicKey, link.Deps{
				Start:     client.Start,
				Poll:      client.Poll,
				Complete:  client.Complete,
				Challenge: link.FetchChallenge(&http.Client{Timeout: 15 * time.Second}, resolved.BaseURL),
				Sign: func(unsigned string) (string, error) {
					return keys.SignChallenge(keys.DefaultBinary, source, unsigned)
				},
				// flow.Run has already printed the URL — always, because a
				// developer on a remote box needs to copy it to the machine
				// their browser is on. io.Discard is that: try to open it
				// here, and let OpenOrPrint's own fallback print nothing
				// rather than the same URL twice.
				OpenBrowser: func(target string) error {
					return browser.OpenOrPrint(io.Discard, target, noBrowser)
				},
				Listen: func(path string) (link.Callbacks, error) {
					s, err := loopback.New(path)
					if err != nil {
						return nil, err
					}
					return s, nil
				},
				Report: func(line string) { _, _ = fmt.Fprintln(progress, line) },
			})
			if err != nil {
				return err
			}

			if jsonOutput {
				return json.NewEncoder(cmd.OutOrStdout()).Encode(result)
			}

			handle := result.Handle
			if handle == "" {
				handle = "your handle"
			} else {
				handle = "@" + handle
			}
			_, err = fmt.Fprintf(
				cmd.OutOrStdout(),
				"Linked %s to %s on %s.\n",
				result.PublicKey, handle, result.Network,
			)
			return err
		},
	}

	cmd.Flags().StringVar(&network, "network", "testnet", "Stellar network the deploy wallet is on")
	cmd.Flags().BoolVar(&noBrowser, "no-browser", false, "print the approval URL instead of opening a browser")
	cmd.Flags().BoolVar(&jsonOutput, "json", false, "write a single JSON result to stdout instead of a human-readable summary")

	return cmd
}
