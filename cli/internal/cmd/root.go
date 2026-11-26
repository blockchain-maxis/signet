// Package cmd wires up the signet CLI's command tree with Cobra. Subcommands
// that talk to a wallet, a keyring, or a Signet deployment live in their own
// internal packages (link, keys, spec) and are attached here as they land.
package cmd

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
	updatecheck "github.com/blockchain-maxis/signet/cli/internal/update"
)

func newRootCmd(version, commit string) *cobra.Command {
	return newRootCmdWithDeps(version, commit, defaultDeps())
}

// newRootCmdWithDeps builds the command tree around the given Deps, so a test
// can inject a fake `stellar` binary and a fake API client factory. Config is
// resolved per run and overwrites whatever is passed in.
func newRootCmdWithDeps(version, commit string, base Deps) *cobra.Command {
	base.Version, base.Commit = version, commit
	root := &cobra.Command{
		Use:   "signet",
		Short: "Link wallets and manage identity on the Signet registry",
		Long: `signet is the command-line companion to the Signet developer identity
registry on Stellar/Soroban.

It links a local wallet to an on-chain handle, manages signing keys, and
talks to a Signet deployment (the default hosted one, or a self-hosted
instance) over its HTTP API.`,
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.SetContext(withDeps(context.Background(), base))

	// --json is defined once, here, for every command. It promises exactly one
	// JSON object on stdout, or nothing; see internal/output.
	root.PersistentFlags().Bool("json", false,
		"write a single JSON result to stdout instead of human-readable output (diagnostics go to stderr)")
	root.PersistentFlags().String("url", "",
		fmt.Sprintf("Signet deployment URL (overrides %s, the config file, and the default)", config.EnvBaseURL))
	root.PersistentFlags().String("network", "",
		fmt.Sprintf("Stellar network to talk to (overrides %s, the context, and default %q)", config.EnvNetwork, config.DefaultNetwork))
	root.PersistentFlags().String("context", "",
		fmt.Sprintf("deployment context to use (overrides %s and the config file's current context)", config.EnvContext))
	root.PersistentFlags().String("source", "",
		"identity to sign as (remembered in the config file for next time)")
	root.PersistentFlags().Bool("insecure", false,
		"allow a plain-http deployment URL on a non-local host (signed challenges travel in cleartext; use only against a deployment you control)")
	root.PersistentFlags().String("sign-with-key", "",
		fmt.Sprintf("identity to sign with, for non-interactive use (same value as %s; not remembered)", config.EnvSignWithKey))

	// Resolves --url/--network/--context/--source/env vars/the config file into the
	// configuration this run actually uses, and attaches it to the command's
	// context for subcommands to read via config.FromContext. Runs before
	// every command, including the bare root — that's what lets `signet
	// --source alice ...` on any command update the remembered identity.
	root.PersistentPreRunE = func(cmd *cobra.Command, _ []string) error {
		file, err := config.Load()
		var configErr error
		// A command that diagnoses the environment runs on defaults and
		// reports the file/context problem instead of refusing to start (#619).
		toleratesBadConfig := cmd.Annotations[annotationToleratesBadConfig] == "true"
		if err != nil {
			if !toleratesBadConfig {
				return fmt.Errorf("%w: reading config file: %w", exitcode.ErrConfiguration, err)
			}
			file, configErr = config.File{}, err
		}

		// Read the flags from the ROOT's persistent flag set, never
		// cmd.Flags(): a subcommand may define a local flag with the same name
		// (`context add --url/--network/--source`), and those describe the
		// context being added, not this invocation. Reading cmd.Flags() there
		// made `context add staging --source charlie` remember charlie as the
		// current context's identity (#913).
		persistent := root.PersistentFlags()
		flagURL, _ := persistent.GetString("url")
		flagNetwork, _ := persistent.GetString("network")
		flagContext, _ := persistent.GetString("context")
		flagSource, _ := persistent.GetString("source")
		flagSignWith, _ := persistent.GetString("sign-with-key")
		// Keep the explicit-empty diagnostic tied to --sign-with-key. All other
		// non-empty identities are validated after precedence is resolved, so a
		// secret cannot bypass the check through --source, the environment, or a
		// remembered config value.
		if persistent.Changed("sign-with-key") && strings.TrimSpace(flagSignWith) == "" {
			if err := keys.ValidateSignWithKey(flagSignWith); err != nil {
				return err
			}
		}
		opts := config.ResolveOptions{
			FlagURL:            flagURL,
			FlagURLSet:         persistent.Changed("url"),
			FlagNetwork:        flagNetwork,
			FlagNetworkSet:     persistent.Changed("network"),
			FlagContext:        flagContext,
			FlagContextSet:     persistent.Changed("context"),
			FlagSource:         flagSource,
			FlagSourceSet:      persistent.Changed("source"),
			FlagSignWithKey:    flagSignWith,
			FlagSignWithKeySet: persistent.Changed("sign-with-key"),
			EnvBaseURL:         os.Getenv(config.EnvBaseURL),
			EnvNetwork:         os.Getenv(config.EnvNetwork),
			EnvContext:         os.Getenv(config.EnvContext),
			EnvSignWithKey:     os.Getenv(config.EnvSignWithKey),
		}
		resolved, resolveErr := config.Resolve(opts, file)
		if resolveErr != nil {
			if !toleratesBadConfig {
				return fmt.Errorf("%w: %w", exitcode.ErrConfiguration, resolveErr)
			}
			// Report it, and carry on with defaults so a diagnostic command can
			// still say what else is wrong.
			configErr = resolveErr
			opts.FlagContext, opts.FlagContextSet = "", false
			opts.EnvContext = ""
			resolved, _ = config.Resolve(opts, file)
		}
		if resolved.Source != "" {
			if err := keys.ValidateSignWithKey(resolved.Source); err != nil {
				return err
			}
		}
		deps := base
		deps.Config = resolved
		deps.ConfigError = configErr
		deps.Insecure, _ = persistent.GetBool("insecure")
		cmd.SetContext(withDeps(config.WithResolved(cmd.Context(), resolved), deps))

		// Deliberately only --source: --sign-with-key and STELLAR_SIGN_WITH_KEY
		// are not written to the config file, because either may carry a secret
		// and neither is a preference the user asked signet to remember. A run
		// that could not resolve its context writes nothing.
		if opts.FlagSourceSet && resolveErr == nil {
			if err := config.RememberSourceInContext(resolved.Context, resolved.Source); err != nil {
				return fmt.Errorf("%w: saving identity to config file: %w", exitcode.ErrConfiguration, err)
			}
		}
		return nil
	}

	// Cobra only renders the "Usage:" section of --help (and of a bare
	// invocation) when the command is Runnable() or has subcommands — neither
	// is true yet for a fresh scaffold with no subcommands attached. Giving it
	// a RunE that just prints help keeps `signet` and `signet --help` both
	// showing real usage instead of only the Long description.
	root.RunE = func(cmd *cobra.Command, _ []string) error {
		return cmd.Help()
	}

	// Cobra wires --version to this automatically once Version is non-empty.
	root.Version = fmt.Sprintf("%s (commit %s)", version, commit)
	root.SetVersionTemplate("signet version {{.Version}}\n")

	// Commands register themselves into a group from their own file (see
	// commands.go), so adding one never touches this function.
	addRegisteredCommands(root)
	registerFlagCompletions(root, base)

	return root
}

// Execute builds the command tree and runs it against the process's
// arguments. main() only needs to report the error and set an exit code.
func Execute(version, commit string) error {
	return Run(newRootCmd(version, commit))
}

var lastRunJSON bool

// LastRunJSON reports whether the most recent Run execution had --json requested.
func LastRunJSON() bool {
	return lastRunJSON
}

// Run executes root and, when it returns an error, records that error for
// `signet bug-report` before returning it unchanged. Recording is best-effort
// and never alters the error. It is Execute's body and the seam a test uses to
// exercise last-error persistence without a real process exit.
//
// Under --json, Run writes the structured error to stderr on failure so scripts
// receive machine-readable output rather than human text.
func Run(root *cobra.Command) error {
	err := root.Execute()
	lastRunJSON = jsonRequested(root)
	if err != nil {
		recordLastError(err)
		if lastRunJSON {
			_ = WriteErrorJSON(root.ErrOrStderr(), err)
		}
	}
	maybeNotifyUpdate(root)
	return err
}

// maybeNotifyUpdate checks whether a newer signet release exists and prints a
// once-a-day notice to stderr for interactive terminal users.
func maybeNotifyUpdate(root *cobra.Command) {
	if jsonRequested(root) {
		return
	}
	if os.Getenv("CI") != "" || os.Getenv("SIGNET_NO_UPDATE_CHECK") == "1" {
		return
	}
	deps, err := depsFor(root)
	if err != nil || updatecheck.IsDevOrPrerelease(deps.Version) {
		return
	}
	stderr := root.ErrOrStderr()
	if !writerIsTerminal(stderr) {
		return
	}
	opts := deps.updateOptions()
	if opts.CacheDir == "" {
		// Without a cache the check would run, and the notice print, on
		// every command.
		return
	}
	notice, ok := updatecheck.PassiveCheck(context.Background(), deps.Version, opts.CacheDir, opts)
	if ok && notice != "" {
		_, _ = fmt.Fprint(stderr, notice)
	}
}
