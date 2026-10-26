package cmd

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/api"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/link"
	"github.com/blockchain-maxis/signet/cli/internal/pair"
	"github.com/blockchain-maxis/signet/cli/internal/redact"
)

// statusResult is `signet status --json` (documented in docs/CLI.md). Every
// string is redacted before it is printed.
type statusResult struct {
	Context    string        `json:"context,omitempty"`
	Deployment string        `json:"deployment"`
	Network    string        `json:"network"`
	Health     *statusHealth `json:"health"`
	Identity   string        `json:"identity"`
	PublicKey  string        `json:"publicKey"`
	Handle     string        `json:"handle"`
	Linked     bool          `json:"linked"`
	// Wallets are the handle's wallets, with whether each is still waiting
	// for the indexer; null when not linked or the deployment could not say.
	Wallets []statusWallet `json:"wallets"`
	// Contracts is how many contracts the handle's wallets deployed; null
	// when not linked or the deployment could not say.
	Contracts *pair.ContractCount `json:"contracts"`
}

// statusHealth is the deployment's health check, or why there is none.
type statusHealth struct {
	Status   string `json:"status"`
	DB       string `json:"db,omitempty"`
	Registry string `json:"registry,omitempty"`
	Pairing  string `json:"pairing,omitempty"`
	Error    string `json:"error,omitempty"`
}

type statusWallet struct {
	Address         string `json:"address"`
	IsPrimary       bool   `json:"isPrimary"`
	Source          string `json:"source"`
	IndexingPending bool   `json:"indexingPending"`
	This            bool   `json:"this"`
}

func init() { register(groupIdentity, newStatusCmd) }

// newStatusCmd answers "what is going on?" after a link (#630): the profile
// stays empty until the indexer scans the new wallet, and without this a
// developer refreshes their page, sees nothing and assumes the link failed.
func newStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show the deployment, your identity and handle, and indexing progress",
		Long: `Prints the context signet uses (deployment and network) and the
deployment's health, the identity signet signs as, its public key and the
handle it is linked to, and, for each of the handle's wallets, whether the
indexer has scanned it yet.

A wallet that was just linked shows "indexing" until the indexer has scanned
it; its contracts appear on the profile after that.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			resolved := deps.Config
			printer := printerFor(cmd)

			client, err := deps.NewClient(resolved.BaseURL, api.Options{
				UserAgent: api.UserAgent(deps.Version),
				Insecure:  deps.Insecure,
			})
			if err != nil {
				return err
			}
			source, err := keys.Resolve(deps.KeysBinary, resolved.Source, promptForIdentity(cmd.InOrStdin(), printer.Interactive()))
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

			result := statusResult{
				Context:    redact.Secrets(resolved.Context),
				Deployment: redact.Secrets(resolved.BaseURL),
				Network:    redact.Secrets(resolved.Network),
				Identity:   redact.Secrets(source),
				PublicKey:  redact.Secrets(publicKey),
			}
			// A deployment that is down still gets a status: saying so is
			// the point.
			if h, err := client.Health(cmd.Context()); err != nil {
				result.Health = &statusHealth{Status: "unreachable", Error: redact.Secrets(errorWithoutURL(err))}
			} else {
				result.Health = &statusHealth{Status: h.Status, DB: h.Checks.DB, Registry: h.Checks.Registry, Pairing: h.Checks.Pairing}
			}

			identity, err := client.WhoAmI(cmd.Context(), publicKey)
			if err != nil {
				return err
			}
			result.Handle, result.Linked = redact.Secrets(identity.Handle), identity.Linked
			if identity.Linked {
				result.Wallets, result.Contracts = indexingOf(cmd.Context(), client, identity.Handle, publicKey)
			}

			return printer.Result(result, func(w io.Writer) error { return printStatus(w, result) })
		},
	}
}

// indexingOf reads a handle's wallets and contract count; either is nil when
// the deployment could not say.
func indexingOf(ctx context.Context, client *pair.Client, handle, publicKey string) ([]statusWallet, *pair.ContractCount) {
	var wallets []statusWallet
	if list, err := client.Wallets(ctx, handle); err == nil {
		wallets = []statusWallet{}
		for _, w := range list {
			wallets = append(wallets, statusWallet{
				Address: redact.Secrets(w.Address), IsPrimary: w.IsPrimary, Source: redact.Secrets(w.Source),
				IndexingPending: w.IndexingPending, This: w.Address == publicKey,
			})
		}
	}
	var contracts *pair.ContractCount
	if count, err := client.Contracts(ctx, handle); err == nil {
		contracts = &count
	}
	return wallets, contracts
}

func printStatus(w io.Writer, r statusResult) error {
	var b strings.Builder
	deployment := r.Deployment
	if r.Context != "" {
		deployment += " (context " + r.Context + ")"
	}
	fmt.Fprintf(&b, "deployment: %s\n", deployment)
	fmt.Fprintf(&b, "network:    %s\n", r.Network)
	if h := r.Health; h.Status == "unreachable" {
		fmt.Fprintf(&b, "health:     unreachable: %s\n", h.Error)
	} else {
		fmt.Fprintf(&b, "health:     %s (database %s, registry %s, pairing %s)\n", h.Status, orUnknown(h.DB), orUnknown(h.Registry), orUnknown(h.Pairing))
	}
	fmt.Fprintf(&b, "identity:   %s\n", r.Identity)
	fmt.Fprintf(&b, "publicKey:  %s\n", r.PublicKey)
	if !r.Linked {
		b.WriteString("handle:     not linked — run `signet link` to attach this wallet\n")
		_, err := io.WriteString(w, b.String())
		return err
	}
	fmt.Fprintf(&b, "handle:     @%s\n", r.Handle)
	if r.Wallets == nil {
		b.WriteString("wallets:    unknown: the deployment did not list them\n")
	} else {
		b.WriteString("wallets:\n")
		for _, wl := range r.Wallets {
			var notes []string
			if wl.IsPrimary {
				notes = append(notes, "primary")
			}
			notes = append(notes, wl.Source)
			if wl.This {
				notes = append(notes, "this key")
			}
			state := "indexed"
			if wl.IndexingPending {
				state = "indexing"
			}
			fmt.Fprintf(&b, "  %s  %-8s %s\n", wl.Address, state, strings.Join(notes, ", "))
		}
	}
	if c := r.Contracts; c != nil {
		fmt.Fprintf(&b, "contracts:  %s\n", contractsPhrase(*c))
	}
	if anyIndexing(r.Wallets) {
		b.WriteString("\nThe indexer has not scanned every wallet yet; contracts appear on the profile once it has.\n")
	}
	_, err := io.WriteString(w, b.String())
	return err
}

// contractsPhrase is "3 contracts", "1 contract", or "100+ contracts".
func contractsPhrase(c pair.ContractCount) string {
	if c.LowerBound {
		return fmt.Sprintf("%d+ contracts", c.Count)
	}
	return fmt.Sprintf("%d %s", c.Count, plural(c.Count, "contract", "contracts"))
}

func anyIndexing(wallets []statusWallet) bool {
	for _, w := range wallets {
		if w.IndexingPending {
			return true
		}
	}
	return false
}
