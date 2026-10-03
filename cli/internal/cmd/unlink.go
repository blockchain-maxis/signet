package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/link"
	"github.com/blockchain-maxis/signet/cli/internal/pair"
	"github.com/blockchain-maxis/signet/cli/internal/redact"
)

// newUnlinkCmd is `signet link` in reverse, and deliberately much shorter:
// there is no browser step, because withdrawing an attestation is not the same
// trust question as making one. Control of the deploy key is the whole proof.
func newUnlinkCmd() *cobra.Command {
	var jsonOutput bool
	var assumeYes bool

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
			resolved, ok := config.FromContext(cmd.Context())
			if !ok {
				return fmt.Errorf("%w: configuration was not resolved", exitcode.ErrConfiguration)
			}

			// Nobody can answer the prompt in CI or a pipe, and reading end of
			// input as "no" would exit 0 and let the pipeline believe the
			// unlink happened. Refuse before touching stellar or the network.
			if !assumeYes && !stdinIsTerminal(cmd.InOrStdin()) {
				return errUnlinkNeedsYes
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

			// Ask which handle the key feeds before anything is signed: the
			// prompt can then name it, and a key that isn't linked is told so
			// now rather than after a challenge was fetched and signed for
			// nothing.
			identity, err := client.WhoAmI(cmd.Context(), publicKey)
			if err != nil {
				return err
			}
			if !identity.Linked {
				if jsonOutput {
					return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]string{
						"publicKey": publicKey,
						"handle":    "",
						"status":    "not-linked",
					})
				}
				_, err := fmt.Fprintf(cmd.OutOrStdout(), "%s is not linked to a Signet profile. Nothing to unlink.\n", publicKey)
				return err
			}

			// Confirm before acting. This is destructive and the developer may
			// have resolved a different identity than they expected, so the
			// key and the handle it feeds are shown rather than assumed.
			if !assumeYes {
				confirmed, err := confirmUnlink(cmd.InOrStdin(), cmd.OutOrStdout(), publicKey, identity.Handle)
				if err != nil {
					return err
				}
				if !confirmed {
					_, err := fmt.Fprintln(cmd.OutOrStdout(), "Cancelled. Nothing was unlinked.")
					return err
				}
			}

			unsigned, passphrase, err := link.FetchChallenge(
				&http.Client{Timeout: 15 * time.Second}, resolved.BaseURL,
			)(cmd.Context(), publicKey)
			if err != nil {
				return err
			}
			signed, err := keys.SignChallenge(keys.DefaultBinary, source, unsigned, passphrase)
			if err != nil {
				return err
			}

			result, err := client.Unlink(cmd.Context(), signed)
			if err != nil {
				return err
			}
			result.Wallet = redact.Secrets(result.Wallet)
			result.Handle = redact.Secrets(result.Handle)

			if jsonOutput {
				return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]string{
					"publicKey": result.Wallet,
					"handle":    result.Handle,
					"status":    "unlinked",
				})
			}

			target := "its profile"
			if result.Handle != "" {
				target = "@" + result.Handle
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "Unlinked %s from %s.\n", result.Wallet, target)
			return err
		},
	}

	cmd.Flags().BoolVar(&assumeYes, "yes", false, "skip the confirmation prompt")
	cmd.Flags().BoolVar(&jsonOutput, "json", false, "write a single JSON result to stdout instead of a human-readable summary")

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
