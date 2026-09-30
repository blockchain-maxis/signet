package cmd

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/link"
	"github.com/blockchain-maxis/signet/cli/internal/redact"
)

// whoamiResult is the --json shape. Every string is redacted before this value
// is rendered: identity and deployment are user-controlled, while handle is
// supplied by the deployment. The public key still comes from `stellar keys
// address`, so signet never needs to read key material itself.
type whoamiResult struct {
	Identity   string `json:"identity"`
	PublicKey  string `json:"publicKey"`
	Deployment string `json:"deployment"`
	Handle     string `json:"handle"`
	Linked     bool   `json:"linked"`
}

func init() { register(groupIdentity, newWhoamiCmd) }

// newWhoamiCmd answers "which account am I actually linked as?" — the most
// common support question for a linking CLI, and a genuinely hard one to
// answer yourself when the keystore has several identities and the config file
// remembers one of them.
//
// Three of the four answers are local (the identity, its public key, the
// deployment); only the handle requires asking the deployment, because only it
// knows what the binding currently resolves to.
func newWhoamiCmd() *cobra.Command {
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

			identity, err := deps.NewClient(resolved.BaseURL).WhoAmI(cmd.Context(), publicKey)
			if err != nil {
				return err
			}

			result := whoamiResult{
				Identity:   redact.Secrets(source),
				PublicKey:  redact.Secrets(publicKey),
				Deployment: redact.Secrets(resolved.BaseURL),
				Handle:     redact.Secrets(identity.Handle),
				Linked:     identity.Linked,
			}

			return printer.Result(result, func(out io.Writer) error {
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
					_, err := fmt.Fprintf(out, "handle:     @%s\n", result.Handle)
					return err
				}
				// Say what to do about it rather than only that it is missing —
				// "not linked" on its own is the state someone runs this command
				// to get out of.
				_, err := fmt.Fprint(out, "handle:     not linked — run `signet link` to attach this wallet\n")
				return err
			})
		},
	}

	return cmd
}
