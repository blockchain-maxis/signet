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

// newIdentityCmd exercises keys.Resolve end-to-end: it never reads a secret
// key itself, only the identity name and the public key `stellar` resolves.
// Later commands that need to sign (`link`, `spec`) share this same
// resolution instead of re-implementing it.
func newIdentityCmd() *cobra.Command {
	var source string

	c := &cobra.Command{
		Use:   "identity",
		Short: "Resolve the Stellar identity signet will sign with",
		Long: `Prints the identity and public key signet will sign with, resolved via
the stellar CLI (stellar keys ls / stellar keys public-key). signet never
reads a secret key itself.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			name, err := keys.Resolve(
				keys.DefaultBinary,
				source,
				promptForIdentity(cmd.InOrStdin(), cmd.OutOrStdout()),
			)
			if err != nil {
				return err
			}
			pk, err := keys.ResolvePublicKey(keys.DefaultBinary, name)
			if err != nil {
				return err
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "identity: %s\npublicKey: %s\n", name, pk)
			return err
		},
	}
	c.Flags().StringVar(&source, "source", "", "Stellar identity to use (skips the ls/prompt step)")
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
