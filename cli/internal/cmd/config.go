package cmd

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

func init() {
	register(groupDeployments, newConfigCmd)
}

// resolvedContextName is the context this invocation acts on: the one
// --context or SIGNET_CONTEXT resolved, not whatever the file happens to call
// current. Without a resolved context (only possible if the root's
// PersistentPreRunE never ran) it falls back to the file's current context.
func resolvedContextName(cmd *cobra.Command, f config.File) string {
	if r, ok := config.FromContext(cmd.Context()); ok && r.Context != "" {
		return r.Context
	}
	if f.Current != "" {
		return f.Current
	}
	return config.DefaultContextName
}

func newConfigCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "Inspect and update settings in the current context",
		Long: `Inspect and update settings in the current deployment context.
Supported keys are: url, network, source, rpc-url.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return cmd.Help()
		},
	}

	cmd.AddCommand(newConfigGetCmd())
	cmd.AddCommand(newConfigSetCmd())
	cmd.AddCommand(newConfigUnsetCmd())
	cmd.AddCommand(newConfigPathCmd())

	return cmd
}

func newConfigGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <key>",
		Short: "Get a configuration value from the current context",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			key := args[0]
			f, err := config.Load()
			if err != nil {
				return fmt.Errorf("%w: reading config: %w", exitcode.ErrConfiguration, err)
			}
			name := resolvedContextName(cmd, f)
			val, err := f.GetConfigIn(name, key)
			if err != nil {
				return err
			}

			printer := printerFor(cmd)
			res := map[string]string{"context": name, "key": key, "value": val}
			return printer.Result(res, func(w io.Writer) error {
				_, err := fmt.Fprintln(w, val)
				return err
			})
		},
	}
}

func newConfigSetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set <key> <value>",
		Short: "Set a configuration value in the current context",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			key, value := args[0], args[1]
			f, err := config.Load()
			if err != nil {
				return fmt.Errorf("%w: reading config: %w", exitcode.ErrConfiguration, err)
			}
			curr := resolvedContextName(cmd, f)
			if err := f.SetConfigIn(curr, key, value); err != nil {
				return err
			}
			if err := config.Save(f); err != nil {
				return fmt.Errorf("%w: saving config: %w", exitcode.ErrConfiguration, err)
			}

			printer := printerFor(cmd)
			res := map[string]string{
				"context": curr,
				"key":     key,
				"value":   value,
			}
			return printer.Result(res, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "Set %s to %q in context %q.\n", key, value, curr)
				return err
			})
		},
	}
}

func newConfigUnsetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "unset <key>",
		Short: "Unset a configuration value in the current context",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			key := args[0]
			f, err := config.Load()
			if err != nil {
				return fmt.Errorf("%w: reading config: %w", exitcode.ErrConfiguration, err)
			}
			curr := resolvedContextName(cmd, f)
			if err := f.UnsetConfigIn(curr, key); err != nil {
				return err
			}
			if err := config.Save(f); err != nil {
				return fmt.Errorf("%w: saving config: %w", exitcode.ErrConfiguration, err)
			}

			printer := printerFor(cmd)
			res := map[string]any{
				"context": curr,
				"key":     key,
				"unset":   true,
			}
			return printer.Result(res, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "Unset %s in context %q.\n", key, curr)
				return err
			})
		},
	}
}

func newConfigPathCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "path",
		Short: "Print the path to the configuration file",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			p, err := config.Path()
			if err != nil {
				return fmt.Errorf("%w: resolving config path: %w", exitcode.ErrConfiguration, err)
			}
			printer := printerFor(cmd)
			return printer.Result(map[string]string{"path": p}, func(w io.Writer) error {
				_, err := fmt.Fprintln(w, p)
				return err
			})
		},
	}
}
