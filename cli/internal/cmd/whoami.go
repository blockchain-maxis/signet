package cmd

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/link"
	"github.com/blockchain-maxis/signet/cli/internal/pair"
)

// whoamiResult is the --json shape. Note what is absent: nothing here can
// carry a secret, because nothing in this command ever reads one — the public
// key comes from `stellar keys address`, which is why `signet identity` was
// built that way in the first place.
type whoamiResult struct {
	Identity   string `json:"identity"`
	PublicKey  string `json:"publicKey"`
	Deployment string `json:"deployment"`
	Handle     string `json:"handle"`
	Linked     bool   `json:"linked"`
}

// newWhoamiCmd answers "which account am I actually linked as?" — the most
// common support question for a linking CLI, and a genuinely hard one to
// answer yourself when the keystore has several identities and the config file
// remembers one of them.
//
// Three of the four answers are local (the identity, its public key, the
// deployment); only the handle requires asking the deployment, because only it
// knows what the binding currently resolves to.
func newWhoamiCmd() *cobra.Command {
	var jsonOutput bool

	cmd := &cobra.Command{
		Use:   "whoami",
		Short: "Show the identity, deploy key, and handle signet is configured as",
		Long: `Prints the identity signet will sign as, its Stellar public key, the
deployment it talks to, and the handle that key is currently attributed to —
or that it is not linked yet.

Never prints a secret key: the public key is resolved through the stellar CLI,
which keeps key material out of signet entirely.`,
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

			identity, err := pair.New(resolved.BaseURL).WhoAmI(cmd.Context(), publicKey)
			if err != nil {
				return err
			}

			result := whoamiResult{
				Identity:   source,
				PublicKey:  publicKey,
				Deployment: resolved.BaseURL,
				Handle:     identity.Handle,
				Linked:     identity.Linked,
			}

			if jsonOutput {
				return json.NewEncoder(cmd.OutOrStdout()).Encode(result)
			}

			out := cmd.OutOrStdout()
			if _, err := fmt.Fprintf(out, "identity:   %s\n", result.Identity); err != nil {
				return err
			}
			if _, err := fmt.Fprintf(out, "publicKey:  %s\n", result.PublicKey); err != nil {
				return err
			}
			if _, err := fmt.Fprintf(out, "deployment: %s\n", result.Deployment); err != nil {
				return err
			}
			if result.Linked {
				_, err = fmt.Fprintf(out, "handle:     @%s\n", result.Handle)
				return err
			}
			// Say what to do about it rather than only that it is missing —
			// "not linked" on its own is the state someone runs this command
			// to get out of.
			_, err = fmt.Fprint(out, "handle:     not linked — run `signet link` to attach this wallet\n")
			return err
		},
	}

	cmd.Flags().BoolVar(&jsonOutput, "json", false, "write a single JSON result to stdout instead of a human-readable summary")

	return cmd
}
