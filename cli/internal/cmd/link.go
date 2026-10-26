package cmd

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/signal"
	"time"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/api"
	"github.com/blockchain-maxis/signet/cli/internal/browser"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/link"
	"github.com/blockchain-maxis/signet/cli/internal/loopback"
	"github.com/blockchain-maxis/signet/cli/internal/pair"
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
	var wait time.Duration

	cmd := &cobra.Command{
		Use:   "link",
		Short: "Attach this machine's deploy wallet to your Signet handle",
		Long: `Links the wallet you deploy contracts from to your Signet handle.

signet prints a URL to approve in your browser. Approving it proves you own
the handle; signing a challenge with your local identity proves you control
the deploy key. Both are required, and signet never reads your secret key —
signing goes through the stellar CLI.

The profile shows the wallet's contracts once Signet's indexer has scanned
it. --wait keeps signet running until then (5m by default, or
--wait=<duration>) and prints what it found; running out of time is not an
error. signet status shows the same progress later.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			resolved := deps.Config
			printer := printerFor(cmd)

			network := deps.Config.Network
			client, err := deps.NewClient(resolved.BaseURL, api.Options{
				UserAgent: api.UserAgent(deps.Version),
				Insecure:  deps.Insecure,
			})
			if err != nil {
				return err
			}
			// Before anything else, including resolving an identity: a
			// network the deployment does not serve is a configuration
			// error with a fix, not a 400 halfway through pairing (#618).
			if err := checkDeploymentNetwork(cmd.Context(), client.API(), network, printer); err != nil {
				return err
			}

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

			// Ctrl-C ends the wait cleanly: link.Run reports the abandoned
			// pairing (exit 130) instead of the process dying mid-line.
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt)
			defer stop()

			result, err := link.Run(ctx, resolved.BaseURL, network, source, publicKey, link.Deps{
				Start:     client.Start,
				Poll:      client.Poll,
				Complete:  client.Complete,
				Challenge: link.FetchChallenge(client.API(), network, spec.CliLinkPurposeLink),
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
				Report:       printer.Progress,
				PollInterval: linkPollInterval,
			})
			if err != nil {
				return err
			}
			result.Handle = redact.Secrets(result.Handle)
			result.PublicKey = redact.Secrets(result.PublicKey)
			result.Network = redact.Secrets(result.Network)

			out := linkResult{Result: result}
			if wait > 0 && result.Handle != "" {
				out.Indexing = waitForIndexing(cmd.Context(), client, result.Handle, publicKey, wait, printer.Progress)
			}

			return printer.Result(out, func(w io.Writer) error {
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
				if _, err := fmt.Fprintf(w, "%s %s to %s on %s.\n", verb, result.PublicKey, handle, result.Network); err != nil {
					return err
				}
				if ix := out.Indexing; ix != nil {
					if ix.Done {
						_, err := fmt.Fprintf(w, "indexed: %s found\n", contractsPhrase(ix.contractCount()))
						return err
					}
					_, err := fmt.Fprint(w, "still indexing, check `signet status` later\n")
					return err
				}
				return nil
			})
		},
	}

	cmd.Flags().BoolVar(&noBrowser, "no-browser", false, "print the approval URL instead of opening a browser")
	cmd.Flags().DurationVar(&wait, "wait", 0, "after linking, wait up to this long for the indexer to scan the wallet (--wait alone: 5m)")
	cmd.Flags().Lookup("wait").NoOptDefVal = "5m"

	return cmd
}

// linkResult is link's --json result: the link, and with --wait what the
// indexer did.
type linkResult struct {
	link.Result
	Indexing *linkIndexing `json:"indexing,omitempty"`
}

// linkIndexing is --wait's outcome. Done is false when the wait ran out.
type linkIndexing struct {
	Done       bool `json:"done"`
	Contracts  *int `json:"contracts,omitempty"`
	LowerBound bool `json:"contractsLowerBound,omitempty"`
}

func (ix *linkIndexing) contractCount() pair.ContractCount {
	n := 0
	if ix.Contracts != nil {
		n = *ix.Contracts
	}
	return pair.ContractCount{Count: n, LowerBound: ix.LowerBound}
}

// linkWaitInterval is how often --wait asks; a variable so tests need not
// sleep real seconds.
var linkWaitInterval = 5 * time.Second

// waitForIndexing polls the handle's wallets until the linked one is no
// longer waiting for the indexer, or the wait runs out (#630). Running out,
// or a deployment that cannot answer, is not a failure: the link itself
// succeeded.
func waitForIndexing(ctx context.Context, client *pair.Client, handle, publicKey string, wait time.Duration, progress func(string)) *linkIndexing {
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	progress(fmt.Sprintf("Waiting up to %s for the indexer to scan %s…", wait, publicKey))
	for {
		if wallets, err := client.Wallets(ctx, handle); err == nil && indexed(wallets, publicKey) {
			ix := &linkIndexing{Done: true}
			if c, err := client.Contracts(ctx, handle); err == nil {
				ix.Contracts, ix.LowerBound = &c.Count, c.LowerBound
			}
			return ix
		}
		select {
		case <-ctx.Done():
			return &linkIndexing{Done: false}
		case <-time.After(linkWaitInterval):
		}
	}
}

// indexed reports whether publicKey is among wallets and scanned.
func indexed(wallets []pair.Wallet, publicKey string) bool {
	for _, w := range wallets {
		if w.Address == publicKey {
			return !w.IndexingPending
		}
	}
	return false
}

// linkPollInterval overrides link.PollInterval when non-zero. A variable so a
// test driving the whole command does not sleep real seconds between polls.
var linkPollInterval time.Duration

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
