package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/link"
	"github.com/blockchain-maxis/signet/cli/internal/pair"
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

			// Confirm before acting. This is destructive and the developer may
			// have resolved a different identity than they expected, so the
			// key is shown rather than assumed.
			if !assumeYes {
				confirmed, err := confirmUnlink(cmd.InOrStdin(), cmd.OutOrStdout(), publicKey)
				if err != nil {
					return err
				}
				if !confirmed {
					_, err := fmt.Fprintln(cmd.OutOrStdout(), "Cancelled. Nothing was unlinked.")
					return err
				}
			}

			unsigned, err := link.FetchChallenge(
				&http.Client{Timeout: 15 * time.Second}, resolved.BaseURL,
			)(cmd.Context(), publicKey)
			if err != nil {
				return err
			}
			signed, err := keys.SignChallenge(keys.DefaultBinary, source, unsigned)
			if err != nil {
				return err
			}

			result, err := pair.New(resolved.BaseURL).Unlink(cmd.Context(), signed)
			if err != nil {
				return err
			}

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
