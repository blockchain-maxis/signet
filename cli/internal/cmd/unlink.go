package cmd

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/link"
)

func init() { register(groupIdentity, newUnlinkCmd) }

// newUnlinkCmd is `signet link` in reverse, and deliberately much shorter:
// there is no browser step, because withdrawing an attestation is not the same
// trust question as making one. Control of the deploy key is the whole proof.
func newUnlinkCmd() *cobra.Command {
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

			// Confirm before acting. This is destructive and the developer may
			// have resolved a different identity than they expected, so the
			// key is shown rather than assumed.
			if !assumeYes {
				confirmed, err := confirmUnlink(cmd.InOrStdin(), printer.Interactive(), publicKey)
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

			unsigned, err := link.FetchChallenge(
				&http.Client{Timeout: 15 * time.Second}, resolved.BaseURL,
			)(cmd.Context(), publicKey)
			if err != nil {
				return err
			}
			signed, err := keys.SignChallenge(deps.KeysBinary, source, unsigned)
			if err != nil {
				return err
			}

			result, err := deps.NewClient(resolved.BaseURL).Unlink(cmd.Context(), signed)
			if err != nil {
				return err
			}

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

	cmd.Flags().BoolVar(&assumeYes, "yes", false, "skip the confirmation prompt")

	return cmd
}

// confirmUnlink asks before removing the binding. Anything but an explicit
// y/yes is a no — a prompt that treats a stray newline as consent is not a
// confirmation.
func confirmUnlink(in io.Reader, out io.Writer, publicKey string) (bool, error) {
	if _, err := fmt.Fprintf(out, "Unlink %s from its Signet profile? [y/N] ", publicKey); err != nil {
		return false, err
	}
	scanner := bufio.NewScanner(in)
	if !scanner.Scan() {
		return false, nil
	}
	answer := strings.ToLower(strings.TrimSpace(scanner.Text()))
	return answer == "y" || answer == "yes", nil
}
