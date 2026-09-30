package cmd

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/browser"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/link"
	"github.com/blockchain-maxis/signet/cli/internal/loopback"
	"github.com/blockchain-maxis/signet/cli/internal/redact"
)

func init() { register(groupIdentity, newLinkCmd) }

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
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			resolved := deps.Config
			printer := printerFor(cmd)

			source, err := keys.Resolve(
				deps.KeysBinary,
				resolved.Source,
				promptForIdentity(cmd.InOrStdin(), printer.Interactive()),
			)
			if err != nil {
				return err
			}
			publicKey, err := keys.ResolvePublicKey(deps.KeysBinary, source)
			if err != nil {
				return err
			}
			if err := link.ValidatePublicKey(publicKey); err != nil {
				return err
			}

			client := deps.NewClient(resolved.BaseURL)

			result, err := link.Run(cmd.Context(), resolved.BaseURL, network, source, publicKey, link.Deps{
				Start:     client.Start,
				Poll:      client.Poll,
				Complete:  client.Complete,
				Challenge: link.FetchChallenge(&http.Client{Timeout: 15 * time.Second}, resolved.BaseURL, network),
				Sign: func(unsigned, passphrase string) (string, error) {
					return keys.SignChallenge(deps.KeysBinary, source, unsigned, passphrase)
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
					// Only the deployment the developer is linking against may
					// reach this port cross-origin, and only for as long as the
					// command runs.
					s.AllowOrigin = originOf(resolved.BaseURL)
					return s, nil
				},
				// Progress goes through the Printer: stdout for a person,
				// stderr under --json so the result stays parseable.
				Report: printer.Progress,
			})
			if err != nil {
				return err
			}
			result.Handle = redact.Secrets(result.Handle)
			result.PublicKey = redact.Secrets(result.PublicKey)
			result.Network = redact.Secrets(result.Network)

			return printer.Result(result, func(w io.Writer) error {
				handle := result.Handle
				if handle == "" {
					handle = "your handle"
				} else {
					handle = "@" + handle
				}
				_, err := fmt.Fprintf(w, "Linked %s to %s on %s.\n", result.PublicKey, handle, result.Network)
				return err
			})
		},
	}

	cmd.Flags().StringVar(&network, "network", "testnet", "Stellar network the deploy wallet is on")
	cmd.Flags().BoolVar(&noBrowser, "no-browser", false, "print the approval URL instead of opening a browser")

	return cmd
}

// originOf reduces a deployment URL to the scheme://host[:port] a browser will
// send as its Origin header. A path or query on the configured URL is not part
// of an origin, and comparing against one that carries them would never match.
func originOf(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}
