package cmd

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/api"
	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/networkcheck"
)

func init() {
	register(groupDeployments, newContextCmd)
}

func newContextCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "context",
		Short: "Manage named deployment contexts",
		Long: `Manage named deployment contexts. Each context pairs a Signet deployment URL
with a Stellar network and a default signing identity.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return cmd.Help()
		},
	}

	cmd.AddCommand(newContextListCmd())
	cmd.AddCommand(newContextShowCmd())
	cmd.AddCommand(newContextUseCmd())
	cmd.AddCommand(newContextAddCmd())
	cmd.AddCommand(newContextRemoveCmd())

	return cmd
}

type contextListResult struct {
	Current  string                    `json:"current"`
	Contexts map[string]config.Context `json:"contexts"`
}

func newContextListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List all configured deployment contexts",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			f, err := config.Load()
			if err != nil {
				return fmt.Errorf("%w: reading config: %w", exitcode.ErrConfiguration, err)
			}
			printer := printerFor(cmd)

			curr := f.Current
			if curr == "" {
				curr = config.DefaultContextName
			}
			contexts := f.Contexts
			if contexts == nil {
				contexts = make(map[string]config.Context)
			}

			res := contextListResult{
				Current:  curr,
				Contexts: contexts,
			}

			return printer.Result(res, func(w io.Writer) error {
				if len(contexts) == 0 {
					_, err := fmt.Fprintln(w, "No contexts configured.")
					return err
				}
				names := make([]string, 0, len(contexts))
				for name := range contexts {
					names = append(names, name)
				}
				sort.Strings(names)

				tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
				_, _ = fmt.Fprintln(tw, "CURRENT\tNAME\tNETWORK\tURL\tSOURCE")
				for _, name := range names {
					c := contexts[name]
					prefix := " "
					if name == curr {
						prefix = "*"
					}
					_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", prefix, name, c.Network, c.URL, c.Source)
				}
				return tw.Flush()
			})
		},
	}
}

type contextShowResult struct {
	Name    string `json:"name"`
	URL     string `json:"url"`
	Network string `json:"network"`
	Source  string `json:"source"`
}

func newContextShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "show [name]",
		Short:             "Show details for a deployment context",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: completeContextsFunc,
		RunE: func(cmd *cobra.Command, args []string) error {
			f, err := config.Load()
			if err != nil {
				return fmt.Errorf("%w: reading config: %w", exitcode.ErrConfiguration, err)
			}

			// With no argument, show the context this run resolved (--context,
			// SIGNET_CONTEXT or the current one), not whatever the file says.
			target := resolvedContextName(cmd, f)
			if len(args) == 1 && args[0] != "" {
				target = args[0]
			}

			c, ok := f.Contexts[target]
			if !ok {
				return &config.ContextError{
					Msg:  fmt.Sprintf("context %q not found", target),
					Code: exitcode.InvalidInput,
				}
			}

			res := contextShowResult{
				Name:    target,
				URL:     c.URL,
				Network: c.Network,
				Source:  c.Source,
			}

			printer := printerFor(cmd)
			return printer.Result(res, func(w io.Writer) error {
				_, _ = fmt.Fprintf(w, "Context: %s\n", target)
				_, _ = fmt.Fprintf(w, "URL:     %s\n", c.URL)
				_, _ = fmt.Fprintf(w, "Network: %s\n", c.Network)
				_, err := fmt.Fprintf(w, "Source:  %s\n", c.Source)
				return err
			})
		},
	}
}

func newContextUseCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "use <name>",
		Short:             "Switch the active deployment context",
		Args:              cobra.ExactArgs(1),
		ValidArgsFunction: completeContextsFunc,
		RunE: func(cmd *cobra.Command, args []string) error {
			name := args[0]
			f, err := config.Load()
			if err != nil {
				return fmt.Errorf("%w: reading config: %w", exitcode.ErrConfiguration, err)
			}
			if err := f.UseContext(name); err != nil {
				return err
			}
			if err := config.Save(f); err != nil {
				return fmt.Errorf("%w: saving config: %w", exitcode.ErrConfiguration, err)
			}

			printer := printerFor(cmd)
			return printer.Result(map[string]string{"current": name}, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "Switched to context %q.\n", name)
				return err
			})
		},
	}
}

type contextAddResult struct {
	Name       string `json:"name"`
	URL        string `json:"url"`
	Network    string `json:"network"`
	Source     string `json:"source"`
	RPCURL     string `json:"rpcUrl"`
	Discovered bool   `json:"discovered"`
}

func newContextAddCmd() *cobra.Command {
	var urlFlag, networkFlag, sourceFlag, rpcURLFlag string
	var forceFlag bool

	cmd := &cobra.Command{
		Use:   "add <name> --url <url> [--network <network>] [--rpc-url <url>] [--source <source>] [--force]",
		Short: "Add a new deployment context",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := strings.TrimSpace(args[0])
			if name == "" {
				return &config.ContextError{Msg: "context name cannot be empty", Code: exitcode.InvalidInput}
			}
			if strings.TrimSpace(urlFlag) == "" {
				return &config.ContextError{Msg: "--url is required", Code: exitcode.InvalidInput}
			}

			f, err := config.Load()
			if err != nil {
				return fmt.Errorf("%w: reading config: %w", exitcode.ErrConfiguration, err)
			}
			if !forceFlag && f.Contexts != nil {
				if _, exists := f.Contexts[name]; exists {
					return &config.ContextError{
						Msg:  fmt.Sprintf("context %q already exists; pass --force to replace it", name),
						Code: exitcode.InvalidInput,
					}
				}
			}

			printer := printerFor(cmd)
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			client, err := deps.NewClient(urlFlag, api.Options{
				UserAgent: api.UserAgent(deps.Version),
				Insecure:  deps.Insecure,
			})
			if err != nil {
				return err
			}

			discovered := false
			resolvedNetwork := strings.TrimSpace(networkFlag)
			if norm, ok := networkcheck.Normalize(resolvedNetwork); ok {
				resolvedNetwork = norm
			}

			deployment, discErr := client.API().Discover(cmd.Context())
			if discErr != nil {
				var apiErr *api.Error
				reason := fmt.Sprintf("deployment %s could not be reached to discover its network (%v)", urlFlag, discErr)
				if errors.As(discErr, &apiErr) && apiErr.Status == http.StatusNotFound {
					reason = fmt.Sprintf("deployment %s publishes no /.well-known/stellar.toml", urlFlag)
				}
				if resolvedNetwork == "" {
					return &config.ContextError{
						Msg:  fmt.Sprintf("%s; pass --network explicitly", reason),
						Code: exitcode.InvalidInput,
					}
				}
				printer.Diagnostic("note: " + reason + "; trusting --network " + resolvedNetwork)
			} else if deployment.NetworkPassphrase == "" {
				if resolvedNetwork == "" {
					return &config.ContextError{
						Msg:  fmt.Sprintf("deployment %s stellar.toml has no NETWORK_PASSPHRASE; pass --network explicitly", urlFlag),
						Code: exitcode.InvalidInput,
					}
				}
			} else if resolvedNetwork != "" {
				if err := networkcheck.Compare(resolvedNetwork, deployment); err != nil {
					return err
				}
			} else {
				detected, ok := networkcheck.NameFor(deployment.NetworkPassphrase)
				if !ok {
					return &config.ContextError{
						Msg:  fmt.Sprintf("deployment %s publishes unrecognized NETWORK_PASSPHRASE %q; pass --network explicitly", urlFlag, deployment.NetworkPassphrase),
						Code: exitcode.InvalidInput,
					}
				}
				resolvedNetwork = detected
				discovered = true
			}

			newCtx := config.Context{
				URL:     urlFlag,
				Network: resolvedNetwork,
				Source:  sourceFlag,
				RPCURL:  rpcURLFlag,
			}
			if err := f.AddContext(name, newCtx, forceFlag); err != nil {
				return err
			}
			if err := config.Save(f); err != nil {
				return fmt.Errorf("%w: saving config: %w", exitcode.ErrConfiguration, err)
			}

			res := contextAddResult{
				Name:       name,
				URL:        urlFlag,
				Network:    resolvedNetwork,
				Source:     sourceFlag,
				RPCURL:     rpcURLFlag,
				Discovered: discovered,
			}
			return printer.Result(res, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "Added context %q.\n", name)
				return err
			})
		},
	}

	cmd.Flags().StringVar(&urlFlag, "url", "", "Signet deployment URL (required)")
	cmd.Flags().StringVar(&networkFlag, "network", "", "Stellar network (discovered from stellar.toml if omitted)")
	cmd.Flags().StringVar(&rpcURLFlag, "rpc-url", "", "Stellar RPC URL for sandbox commands (optional)")
	cmd.Flags().StringVar(&sourceFlag, "source", "", "Default identity for this context (optional)")
	cmd.Flags().BoolVar(&forceFlag, "force", false, "Replace an existing context of the same name")
	_ = cmd.RegisterFlagCompletionFunc("network", completeNetworksFunc)
	_ = cmd.RegisterFlagCompletionFunc("source", completeIdentitiesFunc(defaultDeps()))

	return cmd
}

func newContextRemoveCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "remove <name>",
		Short:             "Remove a deployment context",
		Args:              cobra.ExactArgs(1),
		ValidArgsFunction: completeContextsFunc,
		RunE: func(cmd *cobra.Command, args []string) error {
			name := args[0]
			f, err := config.Load()
			if err != nil {
				return fmt.Errorf("%w: reading config: %w", exitcode.ErrConfiguration, err)
			}
			if err := f.RemoveContext(name); err != nil {
				return err
			}
			if err := config.Save(f); err != nil {
				return fmt.Errorf("%w: saving config: %w", exitcode.ErrConfiguration, err)
			}

			printer := printerFor(cmd)
			return printer.Result(map[string]string{"removed": name}, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "Removed context %q.\n", name)
				return err
			})
		},
	}
}
