package cmd

import (
	"context"
	"fmt"
	"time"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/api"
	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/fork"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/output"
	"github.com/blockchain-maxis/signet/cli/internal/pair"
	"github.com/blockchain-maxis/signet/cli/internal/rpc"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// Deps is everything a command needs from the outside world, gathered in one
// place so a test can hand a command fakes instead of the real `stellar`
// binary and a real deployment.
//
// The root command builds one per invocation, fills Config once flags,
// environment and the config file are resolved, and attaches it to the
// command's context. Commands read it with depsFor.
type Deps struct {
	// Config is the resolved configuration for this run: deployment URL and
	// identity. Set by the root's PersistentPreRunE, never by the caller.
	Config config.Resolved
	// NewClient builds the API client for a deployment. The options carry
	// the build's User-Agent and the --insecure escape hatch (#601); it can
	// fail, because a plain-http URL on a remote host is refused.
	NewClient func(baseURL string, opts api.Options) (*pair.Client, error)
	// Insecure mirrors the root --insecure flag: permit plain http to a
	// non-local deployment. Off by default for the obvious reason.
	Insecure bool
	// KeysBinary is the `stellar` executable identity resolution and signing
	// shell out to.
	KeysBinary string
	// Version and Commit identify this build, for `signet version`.
	Version string
	Commit  string

	// LocateSimulator finds signet-simulator and reports a version mismatch
	// through warn (simulator.Find). Only commands that execute contract
	// code call it.
	LocateSimulator func(ctx context.Context, cliVersion string, warn func(string)) (string, error)
	// SimulatorOptions configure every simulator client (tests shorten the
	// timeout or add environment for a fake).
	SimulatorOptions []simulator.Option
	// ForkRoot is where forks are cached (fork.Root).
	ForkRoot func() (string, error)
	// RPCOptions configure every Stellar RPC client.
	RPCOptions []rpc.Option
	// Now is the clock fork ages are measured against.
	Now func() time.Time
	// ConfigError is why the config file did not load, for a command that
	// runs anyway to report it (annotationToleratesBadConfig): doctor.
	ConfigError error
}

// defaultDeps is what production runs with.
func defaultDeps() Deps {
	return Deps{
		NewClient:       pair.New,
		KeysBinary:      keys.DefaultBinary,
		LocateSimulator: simulator.Find,
		ForkRoot:        fork.Root,
		Now:             time.Now,
	}
}

type depsKey struct{}

func withDeps(ctx context.Context, d Deps) context.Context {
	return context.WithValue(ctx, depsKey{}, d)
}

// depsFor returns the Deps the root attached to cmd's context. Its absence
// means the root's PersistentPreRunE never ran, which is a programming error —
// reported as a configuration failure like the missing Resolved it replaces.
func depsFor(cmd *cobra.Command) (Deps, error) {
	d, ok := cmd.Context().Value(depsKey{}).(Deps)
	if !ok {
		return Deps{}, fmt.Errorf("%w: configuration was not resolved", exitcode.ErrConfiguration)
	}
	return d, nil
}

// printerFor builds the Printer for one invocation: --json (the root's
// persistent flag) picks the mode, and the command's own writers pick the
// destinations, so tests capturing cmd.SetOut / cmd.SetErr see everything.
func printerFor(cmd *cobra.Command) *output.Printer {
	return &output.Printer{JSON: jsonRequested(cmd), Out: cmd.OutOrStdout(), Err: cmd.ErrOrStderr()}
}

// jsonRequested reports whether --json was passed.
func jsonRequested(cmd *cobra.Command) bool {
	v, _ := cmd.Flags().GetBool("json")
	return v
}
