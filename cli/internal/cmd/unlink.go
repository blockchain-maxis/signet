package cmd

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/link"
	"github.com/blockchain-maxis/signet/cli/internal/redact"
)

func init() { register(groupIdentity, newUnlinkCmd) }

// newUnlinkCmd is `signet link` in reverse, and deliberately much shorter:
// there is no browser step, because withdrawing an attestation is not the same
// trust question as making one. Control of the deploy key is the whole proof.
func newUnlinkCmd() *cobra.Command {
	var assumeYes bool
	var network string

	cmd := &cobra.Command{
		Use:   "unlink",
		Short: "Detach this machine's deploy wallet from its Signet profile",
		Long: `Removes the binding between the wallet you deploy from and the Signet
profile it feeds, by signing a challenge with your local identity.

A link with no unlink is a one-way door: a rotated or compromised deploy key
would keep feeding a profile with no way to stop it from the terminal that
holds the key. signet never reads your secret key — signing goes through the
stellar CLI.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			resolved := deps.Config
			printer := printerFor(cmd)

			// Nobody can answer the prompt in CI or a pipe, and reading end of
			// input as "no" would exit 0 and let the pipeline believe the
			// unlink happened. Refuse before touching stellar or the network.
			if !assumeYes && !stdinIsTerminal(cmd.InOrStdin()) {
				return errUnlinkNeedsYes
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

			client := deps.NewClient(resolved.BaseURL)

			// Ask which handle the key feeds before anything is signed: the
			// prompt can then name it, and a key that isn't linked is told so
			// now rather than after a challenge was fetched and signed for
			// nothing.
			identity, err := client.WhoAmI(cmd.Context(), publicKey)
			if err != nil {
				return err
			}
			if !identity.Linked {
				return printer.Result(
					map[string]string{
						"publicKey": publicKey,
						"handle":    "",
						"status":    "not-linked",
					},
					func(w io.Writer) error {
						_, err := fmt.Fprintf(w, "%s is not linked to a Signet profile. Nothing to unlink.\n", publicKey)
						return err
					},
				)
			}

			// Confirm before acting. This is destructive and the developer may
			// have resolved a different identity than they expected, so the
			// key and the handle it feeds are shown rather than assumed.
			if !assumeYes {
				confirmed, err := confirmUnlink(cmd.InOrStdin(), printer.Interactive(), publicKey, identity.Handle)
				if err != nil {
					return err
				}
				if !confirmed {
					// Nothing happened, so there is no result to write: a
					// declined prompt is a note to the person, on stderr under
					// --json, and stdout stays empty.
					printer.Progress("Cancelled. Nothing was unlinked.")
					return nil
				}
			}

			unsigned, passphrase, err := link.FetchChallenge(
				&http.Client{Timeout: 15 * time.Second}, resolved.BaseURL, network,
			)(cmd.Context(), publicKey)
			if err != nil {
				return err
			}
			signed, err := keys.SignChallenge(deps.KeysBinary, source, unsigned, passphrase)
			if err != nil {
				return err
			}

			result, err := client.Unlink(cmd.Context(), signed)
			if err != nil {
				return err
			}
			result.Wallet = redact.Secrets(result.Wallet)
			result.Handle = redact.Secrets(result.Handle)

			return printer.Result(
				map[string]string{
					"publicKey": result.Wallet,
					"handle":    result.Handle,
					"status":    "unlinked",
				},
				func(w io.Writer) error {
					target := "its profile"
					if result.Handle != "" {
						target = "@" + result.Handle
					}
					_, err := fmt.Fprintf(w, "Unlinked %s from %s.\n", result.Wallet, target)
					return err
				},
			)
		},
	}

	cmd.Flags().StringVar(&network, "network", "testnet", "Stellar network the deploy wallet is on")
	cmd.Flags().BoolVar(&assumeYes, "yes", false, "skip the confirmation prompt")

	return cmd
}

// unlinkInputError is a refusal caused by how unlink was invoked, mapped to
// exitcode.InvalidInput like link.ValidationError.
type unlinkInputError struct{ msg string }

func (e *unlinkInputError) Error() string { return e.msg }

// ExitCode implements ExitCoder.
func (e *unlinkInputError) ExitCode() int { return exitcode.InvalidInput }

var errUnlinkNeedsYes = &unlinkInputError{"unlink needs --yes when not run interactively"}

// stdinIsTerminal reports whether in is an interactive terminal: an *os.File
// that is a character device. Anything else (a pipe, a file, a test buffer)
// is not. A variable so tests can stand in for a terminal.
var stdinIsTerminal = func(in io.Reader) bool {
	f, ok := in.(*os.File)
	if !ok {
		return false
	}
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

// confirmUnlink asks before removing the binding. Anything but an explicit
// y/yes is a no — a prompt that treats a stray newline as consent is not a
// confirmation.
func confirmUnlink(in io.Reader, out io.Writer, publicKey, handle string) (bool, error) {
	target := "its Signet profile"
	if handle != "" {
		target = "@" + handle
	}
	if _, err := fmt.Fprintf(out, "Unlink %s from %s? [y/N] ", publicKey, target); err != nil {
		return false, err
	}
	scanner := bufio.NewScanner(in)
	if !scanner.Scan() {
		return false, nil
	}
	answer := strings.ToLower(strings.TrimSpace(scanner.Text()))
	return answer == "y" || answer == "yes", nil
}
