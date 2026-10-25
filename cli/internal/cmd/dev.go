package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/dev"
	"github.com/blockchain-maxis/signet/cli/internal/devconfig"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/fork"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/rpc"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

func init() {
	register(groupContracts, newDevCmd)
}

// newDevCmd is `signet dev [contract]` (#563): the local development loop,
// and the parent of dev init.
func newDevCmd() *cobra.Command {
	var path, pkg string
	cmd := &cobra.Command{
		Use:   "dev [contract]",
		Short: "Develop a contract against a fork of its deployment",
		Long: `Develop a contract against a fork of its deployed version: build it, run
its saved calls on the deployed and the new code from the same forked state,
and compare, every time the source changes.

The contract, --path and --package come from the flags or, for what the flags
leave out, from the nearest signet.dev.toml (walking up from the working
directory); signet dev init writes one. Before anything starts, signet dev
checks, in order and each with its own message: the stellar CLI, cargo, the
wasm32v1-none Rust target, a contract (cdylib) crate at --path, the
signet-simulator, and that the simulator runs the network's protocol (exit 11
when it does not; exit 3 for the others).`,
		Example: `  signet dev CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN --path ./contracts/registry
  signet dev            # everything from signet.dev.toml
  signet dev init CASF…RCN --path ./contracts/registry`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runDev(cmd, args, path, pkg)
		},
	}
	addRPCFlags(cmd)
	cmd.Flags().StringVar(&path, "path", "", "the contract's crate directory (default: path in signet.dev.toml)")
	cmd.Flags().StringVar(&pkg, "package", "", "the contract crate, when --path is a workspace with several (default: package in signet.dev.toml)")
	cmd.AddCommand(newDevInitCmd())
	return cmd
}

// devSetup is what signet dev runs on, once flags and signet.dev.toml are
// merged and preflight has passed.
type devSetup struct {
	contract string
	crate    dev.Crate
	file     *devconfig.File
	fileDir  string
}

func runDev(cmd *cobra.Command, args []string, path, pkg string) error {
	deps, err := depsFor(cmd)
	if err != nil {
		return err
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	setup := devSetup{}
	if found := devconfig.Find(cwd); found != "" {
		if setup.file, err = devconfig.Load(found); err != nil {
			return &inputError{err.Error()}
		}
		setup.fileDir = filepath.Dir(found)
	}
	f := setup.file
	if f == nil {
		f = &devconfig.File{}
	}
	// Flags win; signet.dev.toml fills in the rest.
	switch {
	case len(args) == 1:
		setup.contract = args[0]
	case f.Address != "":
		setup.contract = f.Address
	default:
		return &inputError{"signet dev needs a contract: pass its address, or set address in signet.dev.toml (signet dev init writes one)"}
	}
	if err := requireContract(setup.contract); err != nil {
		return err
	}
	if path == "" && f.Path != "" {
		path = f.Path
		if !filepath.IsAbs(path) {
			path = filepath.Join(setup.fileDir, path)
		}
	}
	if path == "" {
		return &inputError{"signet dev needs the contract's crate: --path ./contract, or path in signet.dev.toml"}
	}
	if pkg == "" {
		pkg = f.Package
	}
	if f.Network.Name != "" && !cmd.Flag("network").Changed && os.Getenv("SIGNET_NETWORK") == "" {
		deps.Config.Network = f.Network.Name
	}
	for flag, value := range map[string]string{"rpc-url": f.Network.RPCURL, "network-passphrase": f.Network.Passphrase} {
		if value != "" && !cmd.Flags().Changed(flag) {
			_ = cmd.Flags().Set(flag, value)
		}
	}
	mode, err := driftMode(cmd)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt)
	defer stop()
	printer := printerFor(cmd)

	// Preflight, in order: each missing piece gets its own message.
	binary := deps.KeysBinary
	if binary == "" {
		binary = keys.DefaultBinary
	}
	if err := keys.CheckStellarCLI(binary); err != nil {
		return err
	}
	tools := dev.Tools{}
	if err := dev.CheckCargo(tools); err != nil {
		return err
	}
	if err := dev.CheckWasmTarget(tools); err != nil {
		return err
	}
	if setup.crate, err = dev.FindCrate(tools, path, pkg); err != nil {
		return err
	}
	locate := deps.LocateSimulator
	if locate == nil {
		locate = simulator.Find
	}
	if _, err := locate(ctx, deps.Version, printer.Progress); err != nil {
		return err
	}
	network, err := sandboxNetwork(cmd, deps)
	if err != nil {
		return err
	}
	client, _, err := rpc.Connect(ctx, network, deps.RPCOptions...)
	if err != nil {
		return err
	}
	latest, err := client.GetLatestLedger(ctx)
	if err != nil {
		return err
	}
	sim, err := startSimulator(ctx, deps, printer.Progress)
	if err != nil {
		return err
	}
	lanes := sim.HelloAck()
	_ = sim.Close()
	if err := checkLanes(network.Name, latest.ProtocolVersion, lanes); err != nil {
		return err
	}

	m, err := forkWithDrift(ctx, deps, network, setup.contract, mode, printer.Progress)
	if err != nil {
		return err
	}
	header := fmt.Sprintf("signet dev · %s @ %s ledger %d · lane p%d · crate %s",
		shorten(setup.contract, 4, 3), m.Network, m.ForkLedger, m.Protocol, setup.crate.Name)
	return printer.Result(struct {
		Contract   string `json:"contract"`
		Network    string `json:"network"`
		ForkLedger uint32 `json:"forkLedger"`
		Protocol   int    `json:"protocol"`
		Crate      string `json:"crate"`
		Manifest   string `json:"manifest"`
	}{setup.contract, m.Network, m.ForkLedger, m.Protocol, setup.crate.Name, setup.crate.ManifestPath}, func(w io.Writer) error {
		_, err := fmt.Fprintln(w, header)
		return err
	})
}

func newDevInitCmd() *cobra.Command {
	var (
		path  string
		force bool
	)
	cmd := &cobra.Command{
		Use:   "init <contract>",
		Short: "Write a signet.dev.toml for a deployed contract",
		Long: `Write a commented signet.dev.toml in the current directory for a deployed
contract, with one saved call per read-only function: a function that takes
no arguments and that, run on a fork, wrote nothing (no read-write entry in
its footprint). Arguments for any other function are never guessed: add those
calls with signet sandbox call … --save.

An existing signet.dev.toml is kept unless --force.`,
		Example: `  signet dev init CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN --path ./contracts/registry
  signet dev init CC… --network mainnet --force`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			contract := args[0]
			if err := requireContract(contract); err != nil {
				return err
			}
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			target := filepath.Join(cwd, devconfig.FileName)
			if _, err := os.Stat(target); err == nil && !force {
				return &inputError{fmt.Sprintf("%s already exists; --force replaces it", target)}
			}
			network, err := sandboxNetwork(cmd, deps)
			if err != nil {
				return err
			}
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt)
			defer stop()
			printer := printerFor(cmd)

			functions, ledger, err := specFunctions(ctx, deps, network, contract, printer.Progress)
			if err != nil {
				return err
			}
			var reads []string
			for _, fn := range functions {
				if len(fn.Inputs) > 0 || fn.Name == "__constructor" {
					continue
				}
				res, _, err := runCall(ctx, deps, network, callRequest{
					contract: contract, function: fn.Name, args: map[string]any{}, authMode: "record",
				}, printer.Progress)
				if err != nil {
					return err
				}
				if res.Outcome == "result" && len(res.Modified) == 0 &&
					(res.Resources == nil || len(res.Resources.Footprint.ReadWrite) == 0) {
					reads = append(reads, fn.Name)
				}
			}
			text := devTemplate(contract, network.Name, path, ledger, reads)
			if _, err := devconfig.Parse(target, []byte(text)); err != nil {
				return fmt.Errorf("internal error: the template does not parse: %w", err)
			}
			if err := os.WriteFile(target, []byte(text), 0o644); err != nil {
				return fmt.Errorf("%w: %v", exitcode.ErrConfiguration, err)
			}
			result := struct {
				Path  string   `json:"path"`
				Calls []string `json:"calls"`
			}{target, reads}
			if result.Calls == nil {
				result.Calls = []string{}
			}
			return printer.Result(result, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "Wrote %s with %d saved %s: %s\n", target, len(reads), plural(len(reads), "call", "calls"), strings.Join(reads, ", "))
				return err
			})
		},
	}
	cmd.Flags().StringVar(&path, "path", "", "the contract's crate directory, recorded as path")
	cmd.Flags().BoolVar(&force, "force", false, "replace an existing signet.dev.toml")
	return cmd
}

// specFunction is a function of a contract's spec, as SpecJson lists it.
type specFunction struct {
	Name   string            `json:"name"`
	Inputs []json.RawMessage `json:"inputs"`
}

// specFunctions reads a contract's functions through its fork (made if
// there is none), and the fork ledger they were read at.
func specFunctions(ctx context.Context, deps Deps, network rpc.Network, contract string, progress func(string)) ([]specFunction, uint32, error) {
	root, err := forkRoot(deps)
	if err != nil {
		return nil, 0, err
	}
	info, err := latestFork(root, network, contract)
	if err == nil && info == nil {
		if _, err = forkWithDrift(ctx, deps, network, contract, "warn", progress); err == nil {
			info, err = latestFork(root, network, contract)
		}
	}
	if err != nil {
		return nil, 0, err
	}
	if info == nil {
		return nil, 0, fmt.Errorf("%w: the new fork is not in the cache", exitcode.ErrConfiguration)
	}
	if network.RPCURL == "" {
		network.RPCURL = info.RPCURL
	}
	client, _, err := rpc.Connect(ctx, network, deps.RPCOptions...)
	if err != nil {
		return nil, 0, err
	}
	sim, err := startSimulator(ctx, deps, progress)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = sim.Close() }()
	cache, err := fork.Open(root, network.Passphrase, info.ID)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = cache.Close() }()
	fetcher := &fork.Fetcher{Ctx: ctx, Cache: cache, RPC: client, ForkLedger: info.ForkLedger}
	sim.HandleFetch(fetcher.Fetch)
	protocol, sequence := info.Protocol, info.ForkLedger
	if _, err := callSimulator(ctx, sim, simulator.TypeLedgerOpen, simulator.LedgerOpenParams{
		NetworkPassphrase: network.Passphrase, LedgerProtocol: &protocol, Sequence: &sequence,
	}, nil); err != nil {
		return nil, 0, err
	}
	var spec simulator.SpecExtractResult
	if _, err := callSimulator(ctx, sim, simulator.TypeSpecExtract, simulator.SpecExtractParams{Source: simulator.Source{ContractID: contract}}, &spec); err != nil {
		var se *simulator.Error
		if errors.As(err, &se) && se.Code == "bad_request" {
			return nil, 0, &inputError{fmt.Sprintf("%s has no spec to read: %s", shorten(contract, 4, 3), se.Message)}
		}
		return nil, 0, err
	}
	var doc struct {
		Functions []specFunction `json:"functions"`
	}
	if err := json.Unmarshal(spec.Spec, &doc); err != nil {
		return nil, 0, fmt.Errorf("%w: the simulator's spec is unreadable: %v", exitcode.ErrSimulator, err)
	}
	return doc.Functions, info.ForkLedger, nil
}

// devTemplate is the commented signet.dev.toml dev init writes.
func devTemplate(contract, network, path string, ledger uint32, reads []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# signet.dev.toml for %s on %s, written by `signet dev init`.\n", contract, network)
	b.WriteString("# The schema and what each part does: docs/SANDBOX.md#signetdevtoml\n")
	b.WriteString("version = 1\n")
	fmt.Fprintf(&b, "network = %q\n", network)
	fmt.Fprintf(&b, "address = %q\n", contract)
	if path != "" {
		fmt.Fprintf(&b, "path = %q   # the contract's crate directory\n", path)
	} else {
		b.WriteString("# path = \"./contracts/my-contract\"   # the contract's crate directory\n")
	}
	b.WriteString(`
[replay]
saved = true                 # replay the [[call]]s below
recent_transactions = 20     # and the contract's last 20 transactions; 0 disables
include_failed = false

`)
	if len(reads) == 0 {
		fmt.Fprintf(&b, "# No function takes no arguments and wrote nothing on a fork at ledger %d.\n", ledger)
	} else {
		fmt.Fprintf(&b, "# One saved call per function that takes no arguments and wrote nothing\n# on a fork at ledger %d.\n", ledger)
	}
	b.WriteString("# Add calls with arguments with `signet sandbox call <contract> <function> --arg … --save`.\n")
	for _, fn := range reads {
		fmt.Fprintf(&b, "\n[[call]]\nname = %q\nfunction = %q\nargs = {}\nexpect = \"unchanged\"   # unchanged | ok | error:<Name> | any\n", fn, fn)
	}
	b.WriteString(`
# A storage override every check runs with (as --set-storage takes it):
# [[override]]
# durability = "persistent"
# key = 'Owner("alice")'
# value = '"G…"'

# [diff]
# ignore_events = []           # event topic prefixes a diff leaves out
# resource_tolerance = { instructions = "10%", fee = "10%" }
`)
	return b.String()
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}
