package cmd

import (
	"fmt"
	"io"
	"sort"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
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
		Use:   "show [name]",
		Short: "Show details for a deployment context",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			f, err := config.Load()
			if err != nil {
				return fmt.Errorf("%w: reading config: %w", exitcode.ErrConfiguration, err)
			}

			target := f.Current
			if target == "" {
				target = config.DefaultContextName
			}
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
		Use:   "use <name>",
		Short: "Switch the active deployment context",
		Args:  cobra.ExactArgs(1),
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

func newContextAddCmd() *cobra.Command {
	var urlFlag, networkFlag, sourceFlag string

	cmd := &cobra.Command{
		Use:   "add <name> --url <url> --network <network> [--source <source>]",
		Short: "Add a new deployment context",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := args[0]
			f, err := config.Load()
			if err != nil {
				return fmt.Errorf("%w: reading config: %w", exitcode.ErrConfiguration, err)
			}

			newCtx := config.Context{
				URL:     urlFlag,
				Network: networkFlag,
				Source:  sourceFlag,
			}
			if err := f.AddContext(name, newCtx); err != nil {
				return err
			}
			if err := config.Save(f); err != nil {
				return fmt.Errorf("%w: saving config: %w", exitcode.ErrConfiguration, err)
			}

			printer := printerFor(cmd)
			res := map[string]string{
				"name":    name,
				"url":     urlFlag,
				"network": networkFlag,
				"source":  sourceFlag,
			}
			return printer.Result(res, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "Added context %q.\n", name)
				return err
			})
		},
	}

	cmd.Flags().StringVar(&urlFlag, "url", "", "Signet deployment URL (required)")
	cmd.Flags().StringVar(&networkFlag, "network", "", "Stellar network (required, e.g. testnet, mainnet)")
	cmd.Flags().StringVar(&sourceFlag, "source", "", "Default identity for this context (optional)")

	return cmd
}

func newContextRemoveCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "remove <name>",
		Short: "Remove a deployment context",
		Args:  cobra.ExactArgs(1),
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
