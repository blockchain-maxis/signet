package cmd

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"time"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/browser"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/link"
	"github.com/blockchain-maxis/signet/cli/internal/loopback"
	"github.com/blockchain-maxis/signet/cli/internal/redact"
	"github.com/blockchain-maxis/signet/cli/internal/spec"
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

			network := deps.Config.Network
			client := deps.NewClient(resolved.BaseURL)

			// Ctrl-C ends the wait cleanly: link.Run reports the abandoned
			// pairing (exit 130) instead of the process dying mid-line.
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt)
			defer stop()

			result, err := link.Run(ctx, resolved.BaseURL, network, source, publicKey, link.Deps{
				Start:     client.Start,
				Poll:      client.Poll,
				Complete:  client.Complete,
				Challenge: link.FetchChallenge(&http.Client{Timeout: 15 * time.Second}, resolved.BaseURL, network, spec.CliLinkPurposeLink),
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
				Prompt: manualCodePrompt(printer.JSON, cmd.InOrStdin()),
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
				verb := "Linked"
				if result.Status == "already-linked" {
					verb = "Already linked:"
				}
				_, err := fmt.Fprintf(w, "%s %s to %s on %s.\n", verb, result.PublicKey, handle, result.Network)
				return err
			})
		},
	}

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

// manualCodePrompt is the prompt link offers for pasting the browser's handoff
// code, or nil when it must stay silent. It needs a person at a terminal: with
// --json the caller was promised one object on stdout and nothing else, and a
// non-terminal stdin has nobody to type.
func manualCodePrompt(json bool, in io.Reader) func(context.Context) (string, error) {
	if json || !stdinIsTerminal(in) {
		return nil
	}
	return readLine(bufio.NewReader(in))
}

// readLine returns a prompt that reads one line from r. The read runs on its
// own goroutine so a cancelled ctx (Ctrl-C, or another path finishing the
// link) is honoured immediately instead of waiting for the next keypress.
func readLine(r *bufio.Reader) func(context.Context) (string, error) {
	return func(ctx context.Context) (string, error) {
		type line struct {
			text string
			err  error
		}
		got := make(chan line, 1)
		go func() {
			text, err := r.ReadString('\n')
			got <- line{text, err}
		}()
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case l := <-got:
			if l.err != nil && l.text == "" {
				return "", l.err
			}
			return l.text, nil
		}
	}
}
