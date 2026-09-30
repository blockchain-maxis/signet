package cmd

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/spf13/cobra"
)

func init() { register(groupIdentity, newIdentityCmd) }

// newIdentityCmd exercises keys.Resolve end-to-end: it never reads a secret
// key itself, only the identity name and the public key `stellar` resolves.
// Later commands that need to sign (`link`, `spec`) share this same
// resolution instead of re-implementing it.
//
// The identity comes from the resolved configuration on the command context
// (#595), exactly like `whoami` — the persistent root `--source` flag,
// `STELLAR_SIGN_WITH_KEY`, and the remembered config-file source, in root.go's
// precedence order. This command previously declared its own local `--source`,
// which shadowed all of that: `signet identity` was the one command that
// forgot what `docs/CLI.md` promises is remembered.
func newIdentityCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "identity",
		Short: "Resolve the Stellar identity signet will sign with",
		Long: `Prints the identity and public key signet will sign with, resolved via
the stellar CLI (stellar keys ls / stellar keys public-key). signet never
reads a secret key itself.

The identity is chosen like every other command: --source, then
STELLAR_SIGN_WITH_KEY, then the source remembered in the config file.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			printer := printerFor(cmd)

			name, err := keys.Resolve(
				deps.KeysBinary,
				deps.Config.Source,
				promptForIdentity(cmd.InOrStdin(), printer.Interactive()),
			)
			if err != nil {
				return err
			}
			pk, err := keys.ResolvePublicKey(deps.KeysBinary, name)
			if err != nil {
				return err
			}
			return printer.Result(
				map[string]string{"identity": name, "publicKey": pk},
				func(w io.Writer) error {
					_, err := fmt.Fprintf(w, "identity: %s\npublicKey: %s\n", name, pk)
					return err
				},
			)
		},
	}
	return c
}

// promptForIdentity numbers the candidates and reads a choice from `in`,
// writing the menu to `out`. Returns a function suitable for keys.Resolve's
// prompt parameter — nil is passed instead when running non-interactively
// (see root.go, which only wires this up for a real terminal).
func promptForIdentity(in io.Reader, out io.Writer) func([]string) (string, error) {
	return func(names []string) (string, error) {
		if _, err := fmt.Fprintln(out, "Multiple Stellar identities found:"); err != nil {
			return "", err
		}
		for i, name := range names {
			if _, err := fmt.Fprintf(out, "  %d) %s\n", i+1, name); err != nil {
				return "", err
			}
		}
		if _, err := fmt.Fprint(out, "Select one: "); err != nil {
			return "", err
		}

		scanner := bufio.NewScanner(in)
		if !scanner.Scan() {
			return "", fmt.Errorf("no selection made: %w", keys.ErrAmbiguousIdentity)
		}
		choice := strings.TrimSpace(scanner.Text())

		if idx, err := strconv.Atoi(choice); err == nil && idx >= 1 && idx <= len(names) {
			return names[idx-1], nil
		}
		for _, name := range names {
			if name == choice {
				return name, nil
			}
		}
		return "", fmt.Errorf("%q is not one of the listed identities", choice)
	}
}
