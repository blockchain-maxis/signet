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
	"time"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/browser"
	"github.com/blockchain-maxis/signet/cli/internal/dev"
	"github.com/blockchain-maxis/signet/cli/internal/devconfig"
	"github.com/blockchain-maxis/signet/cli/internal/devui"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/fork"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/output"
	"github.com/blockchain-maxis/signet/cli/internal/rpc"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

func init() {
	register(groupContracts, newDevCmd)
}

// newDevCmd is `signet dev [contract]` (#563): the local development loop,
// and the parent of dev init.
func newDevCmd() *cobra.Command {
	var (
		path, pkg string
		ci        bool
		debounce  time.Duration
		ui        uiFlags
		scan      uint32
		view      dev.RenderOptions
		timings   string
		ciOpts    ciFlags
	)
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
when it does not; exit 3 for the others).

--ci builds once, runs every check and exits with a code a pipeline can
branch on: 0 clean, 10 a difference in a --fail-on class (or a missed
expect), 12 a build failure, 6 or 7 a network problem or timeout, 11 an
unsupported protocol, 13 a simulator failure. --report writes a JSON report
(sandbox/protocol/schema/v1/ci-report.json) and --junit a JUnit file with
one testcase per replay, interface change and layout finding. With --bundle
the checks run offline, on a repro bundle's state and calls (signet sandbox
export), instead of a live fork.`,
		Example: `  signet dev CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN --path ./contracts/registry
  signet dev            # everything from signet.dev.toml
  signet dev init CASF…RCN --path ./contracts/registry
  signet dev --ci --report report.json --junit junit.xml --fail-on breaking,spec`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if timings != "" && timings != "json" {
				return &inputError{fmt.Sprintf("--timings takes json, not %q", timings)}
			}
			if !ci && (ciOpts.bundle != "" || ciOpts.report != "" || ciOpts.junit != "" || cmd.Flags().Changed("fail-on")) {
				return &inputError{"--bundle, --report, --junit and --fail-on go with --ci"}
			}
			var err error
			if ciOpts.classes, err = parseFailOn(ciOpts.failOn); err != nil {
				return err
			}
			return runDev(cmd, args, path, pkg, ci, debounce, ui, scan, view, timings == "json", ciOpts)
		},
	}
	addRPCFlags(cmd)
	cmd.Flags().StringVar(&path, "path", "", "the contract's crate directory (default: path in signet.dev.toml)")
	cmd.Flags().StringVar(&pkg, "package", "", "the contract crate, when --path is a workspace with several (default: package in signet.dev.toml)")
	cmd.Flags().BoolVar(&ci, "ci", false, "run once, non-interactively, and exit 0 (clean), 10 (a --fail-on difference) or 12 (a failed build)")
	cmd.Flags().StringVar(&ciOpts.bundle, "bundle", "", "with --ci, run offline on this repro bundle's state and calls instead of a live fork")
	cmd.Flags().StringVar(&ciOpts.report, "report", "", "with --ci, write a JSON report here")
	cmd.Flags().StringVar(&ciOpts.junit, "junit", "", "with --ci, write a JUnit XML file here")
	cmd.Flags().StringVar(&ciOpts.failOn, "fail-on", ciDefaultFailOn, "with --ci, what exits 10: breaking, behavioural, cost (replay differences), spec, layout")
	cmd.Flags().DurationVar(&debounce, "debounce", dev.DefaultDebounce, "how long a burst of file changes must settle before one rebuild")
	cmd.Flags().BoolVar(&ui.on, "ui", false, "also serve the local UI on 127.0.0.1 and open it")
	cmd.Flags().BoolVar(&ui.noBrowser, "no-browser", false, "with --ui, print the UI's URL instead of opening a browser")
	cmd.Flags().BoolVar(&view.Verbose, "verbose", false, "print every difference of every replay (storage, events, the auth tree, resources) and the time by phase")
	cmd.Flags().BoolVar(&view.Clear, "clear", false, "clear the screen before each cycle (on a terminal)")
	cmd.Flags().StringVar(&timings, "timings", "", "json: also write each cycle's time by phase (and the start's) to stderr, one JSON object per line")
	cmd.Flags().Uint32Var(&scan, "scan-ledgers", 0, "also scan the newest N ledgers for the contract's transactions that emitted no event (slow: every transaction in them is decoded)")
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

// uiFlags are signet dev's --ui and --no-browser.
type uiFlags struct{ on, noBrowser bool }

func runDev(cmd *cobra.Command, args []string, path, pkg string, ci bool, debounce time.Duration, ui uiFlags, scan uint32, view dev.RenderOptions, timings bool, ciOpts ciFlags) error {
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
	if err := dev.CheckWasmTarget(tools, path); err != nil {
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
	report := &ciReport{Version: 1, Contract: setup.contract, Crate: setup.crate.Name, FailOn: ciOpts.classes}
	failOnLow := setup.file != nil && setup.file.Replay.FailOnLowFidelity
	if ci && ciOpts.bundle != "" {
		return runDevBundle(ctx, deps, printer, binary, setup, ciOpts, report, view)
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
	spawned := time.Now()
	sim, err := startSimulator(ctx, deps, printer.Progress)
	if err != nil {
		return err
	}
	spawn := time.Since(spawned)
	// The same process, kept warm, runs every cycle (#566).
	defer func() { _ = sim.Close() }()
	if err := checkLanes(network.Name, latest.ProtocolVersion, sim.HelloAck()); err != nil {
		return err
	}

	m, err := forkWithDrift(ctx, deps, network, setup.contract, mode, printer.Progress)
	if err != nil {
		return err
	}
	header := fmt.Sprintf("signet dev · %s @ %s ledger %d · lane p%d · crate %s",
		shorten(setup.contract, 4, 3), m.Network, m.ForkLedger, m.Protocol, setup.crate.Name)
	printer.Progress(header)
	opened := time.Now()
	session, err := openDevSession(ctx, deps, network, client, sim, m, fileOverrides(setup.file))
	if err != nil {
		return err
	}
	if timings {
		session.timings = cmd.ErrOrStderr()
		session.writeTiming(startTiming{Event: "start", SpawnMS: ms(spawn), OpenMS: ms(time.Since(opened))})
	}
	defer session.Close()
	if err := session.applyRules(setup.file, setup.contract, printer.Progress); err != nil {
		return err
	}
	view.TTY = !ci && !printer.JSON && writerIsTerminal(printer.Out)
	if f := setup.file; f != nil {
		view.FailOnLowFidelity = f.Replay.FailOnLowFidelity
	}
	session.view = view
	session.collectReal(ctx, client, network.Name, setup.contract, setup.file, scan, printer.Progress)
	logDir := setup.fileDir
	if logDir == "" {
		logDir = cwd
	}
	if err := session.startLog(logDir, deps.Version); err != nil {
		printer.Progress("warning: no session log (signet sandbox export needs one): " + err.Error())
	}

	// The initial build (#564). A failure keeps going interactively, where
	// the next save retries it; with --ci it is exit 12.
	builder := &dev.Builder{Stellar: binary, Crate: setup.crate}
	began := time.Now()
	built, buildErr := builder.Build(ctx)
	took := time.Since(began)
	var cycle *dev.Cycle
	switch {
	case buildErr == nil:
		c, err := session.runCycle(ctx, built.Wasm, took, session.replays(setup.file), printer.Progress)
		if err != nil {
			return err
		}
		cycle = &c
	case dev.IsBuildError(buildErr) && ci:
		session.buildFailed(took, "", buildErr, printer.Progress)
		report.buildFailed(took, buildErr)
		if err := report.write(ciOpts); err != nil {
			return err
		}
		return buildErr
	case dev.IsBuildError(buildErr):
		session.buildFailed(took, "", buildErr, printer.Progress)
	default:
		return buildErr
	}
	if !ci {
		if ui.on {
			sessionView := &uiSession{deps: deps, network: network, session: session, builder: builder, setup: &setup}
			stopUI, err := startUI(ctx, cmd, sessionView, ui.noBrowser, printer.Progress)
			if err != nil {
				return err
			}
			defer stopUI()
		}
		return watchAndRebuild(ctx, setup, builder, session, debounce, printer.Progress)
	}
	report.Network, report.ForkLedger, report.Protocol, report.Wasm = m.Network, m.ForkLedger, m.Protocol, builder.Last()
	report.Note = fmt.Sprintf("ran on a live fork of %s at ledger %d: real-transaction replays and the fetched state depend on the network; --bundle runs offline", m.Network, m.ForkLedger)
	report.Build.DurationMS = ms(took)
	report.judge(cycle, failOnLow)
	if err := report.write(ciOpts); err != nil {
		return err
	}
	if err := printer.Result(struct {
		Contract   string     `json:"contract"`
		Network    string     `json:"network"`
		ForkLedger uint32     `json:"forkLedger"`
		Protocol   int        `json:"protocol"`
		Crate      string     `json:"crate"`
		Manifest   string     `json:"manifest"`
		Wasm       string     `json:"wasm,omitempty"`
		Cycle      *dev.Cycle `json:"cycle,omitempty"`
		Report     *ciReport  `json:"report"`
	}{setup.contract, m.Network, m.ForkLedger, m.Protocol, setup.crate.Name, setup.crate.ManifestPath, builder.Last(), cycle, report}, nil); err != nil {
		return err
	}
	if n := report.failures(); n > 0 {
		return &diffFoundError{n}
	}
	return nil
}

// runDevBundle is --ci --bundle: the build checked offline against a repro
// bundle's state and calls (#573), with fetching denied.
func runDevBundle(ctx context.Context, deps Deps, printer *output.Printer, binary string, setup devSetup, ciOpts ciFlags, report *ciReport, view dev.RenderOptions) error {
	b, err := loadBundle(ciOpts.bundle)
	if err != nil {
		return err
	}
	if b.Fork.Contract != setup.contract {
		return &inputError{fmt.Sprintf("%s is a bundle of %s, not %s", ciOpts.bundle, b.Fork.Contract, setup.contract)}
	}
	report.Offline, report.Network, report.ForkLedger, report.Protocol = true, b.Network.Name, b.Fork.Ledger, b.Simulator.Lane
	report.Note = "ran offline on " + filepath.Base(ciOpts.bundle) + " (bundleHash " + b.BundleHash + ")"
	view.TTY = false
	builder := &dev.Builder{Stellar: binary, Crate: setup.crate}
	began := time.Now()
	built, buildErr := builder.Build(ctx)
	took := time.Since(began)
	report.Build.DurationMS = ms(took)
	if buildErr != nil {
		if !dev.IsBuildError(buildErr) {
			return buildErr
		}
		printer.Progress(strings.TrimSuffix(dev.Render(dev.Frame{Build: took, BuildError: buildErr.Error()}, view), "\n"))
		report.buildFailed(took, buildErr)
		if err := report.write(ciOpts); err != nil {
			return err
		}
		return buildErr
	}
	local, err := os.ReadFile(built.Wasm)
	if err != nil {
		return fmt.Errorf("%w: reading the build: %v", exitcode.ErrConfiguration, err)
	}
	report.Wasm = built.Wasm
	sim, err := startSimulator(ctx, deps, printer.Progress)
	if err != nil {
		return err
	}
	defer func() { _ = sim.Close() }()
	if err := requireLane(sim.HelloAck(), b.Simulator.Lane); err != nil {
		return err
	}
	cycle, err := replayBundle(ctx, sim, b, local)
	if err != nil {
		return err
	}
	printer.Progress(strings.TrimSuffix(dev.Render(dev.Frame{Build: took, Cycle: &cycle}, view), "\n"))
	report.judge(&cycle, setup.file != nil && setup.file.Replay.FailOnLowFidelity)
	if err := report.write(ciOpts); err != nil {
		return err
	}
	if err := printer.Result(report, nil); err != nil {
		return err
	}
	if n := report.failures(); n > 0 {
		return &diffFoundError{n}
	}
	return nil
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
			// signet dev's session logs (#572) stay out of the repository.
			if err := gitignore(cwd, ".signet/"); err != nil {
				printer.Progress("warning: could not add .signet/ to .gitignore: " + err.Error())
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

// watchAndRebuild is the interactive loop (#565): every settled burst of
// source changes rebuilds, a newer one cancelling a build in flight, and a
// change to signet.dev.toml alone replays without a rebuild. It runs until
// Ctrl-C.
func watchAndRebuild(ctx context.Context, setup devSetup, builder *dev.Builder, session *devSession, debounce time.Duration, progress func(string)) error {
	files := []string{}
	if root := setup.crate.WorkspaceRoot; root != "" {
		files = append(files, filepath.Join(root, "Cargo.toml"), filepath.Join(root, "Cargo.lock"))
	}
	devFile := ""
	if setup.file != nil {
		devFile = filepath.Join(setup.fileDir, devconfig.FileName)
	}
	crateDir := filepath.Dir(setup.crate.ManifestPath)
	triggers, err := dev.Watch(ctx, dev.WatchOptions{CrateDir: crateDir, Files: files, DevFile: devFile, Debounce: debounce})
	if err != nil {
		return fmt.Errorf("%w: watching %s: %v", exitcode.ErrConfiguration, crateDir, err)
	}
	progress(fmt.Sprintf("watching %s for changes (Ctrl-C to stop)", crateDir))

	type outcome struct {
		built dev.Built
		took  time.Duration
		err   error
	}
	results := make(chan outcome, 1)
	building, again := false, false
	var cancel context.CancelFunc = func() {}
	start := func() {
		var bctx context.Context
		bctx, cancel = context.WithCancel(ctx)
		building, again = true, false
		session.publish("build.started", nil)
		go func() {
			began := time.Now()
			built, err := builder.Build(bctx)
			results <- outcome{built, time.Since(began), err}
		}()
	}
	defer func() { cancel() }()
	// A failed cycle is said and the loop goes on: the next save retries.
	active := builder.Last()
	replay := func(wasm string, took time.Duration) {
		if _, err := session.runCycle(ctx, wasm, took, session.replays(setup.file), progress); err != nil && ctx.Err() == nil {
			progress("replay failed: " + err.Error())
		}
	}
	for {
		select {
		case <-ctx.Done():
			if building {
				<-results
			}
			return nil
		case t, ok := <-triggers:
			if !ok {
				return nil
			}
			if !t.Rebuild {
				progress("signet.dev.toml changed: replaying on the current build")
				reloaded, err := devconfig.Load(devFile)
				if err != nil {
					progress(err.Error() + "\n(keeping the calls as they were)")
					continue
				}
				setup.file = reloaded
				if err := session.applyFile(ctx, setup.file, setup.contract, progress); err != nil {
					progress(err.Error())
				}
				if builder.Last() != "" && !building {
					replay(builder.Last(), 0)
				}
				continue
			}
			if building {
				// Stop the stale build; the next starts once it has.
				again = true
				cancel()
				continue
			}
			progress(fmt.Sprintf("changed: %s; rebuilding", strings.Join(relativeTo(crateDir, t.Paths), ", ")))
			start()
		case o := <-results:
			building = false
			switch {
			case errors.Is(o.err, context.Canceled):
			case o.err == nil:
				active = o.built.Wasm
				if !again {
					replay(o.built.Wasm, o.took)
				}
			default:
				session.buildFailed(o.took, active, o.err, progress)
				session.publish("build.failed", map[string]string{"message": o.err.Error()})
			}
			if again && ctx.Err() == nil {
				progress("rebuilding for a newer change")
				start()
			}
		}
	}
}

func relativeTo(dir string, paths []string) []string {
	out := make([]string, len(paths))
	for i, p := range paths {
		if rel, err := filepath.Rel(dir, p); err == nil && !strings.HasPrefix(rel, "..") {
			p = rel
		}
		out[i] = p
	}
	return out
}

// gitignore adds pattern to dir's .gitignore unless a line already says it.
func gitignore(dir, pattern string) error {
	path := filepath.Join(dir, ".gitignore")
	raw, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) == pattern || strings.TrimSpace(line) == strings.TrimSuffix(pattern, "/") {
			return nil
		}
	}
	if len(raw) > 0 && !strings.HasSuffix(string(raw), "\n") {
		raw = append(raw, '\n')
	}
	raw = append(raw, []byte("# signet dev session logs\n"+pattern+"\n")...)
	return os.WriteFile(path, raw, 0o644)
}

// startUI serves the local UI (#576) over the session (#577) until ctx
// ends, and opens it (or, with --no-browser or no display, prints its URL).
// The token is only ever in that URL's fragment.
func startUI(ctx context.Context, cmd *cobra.Command, view *uiSession, noBrowser bool, progress func(string)) (func(), error) {
	view.session.mu.Lock()
	view.session.events = devui.NewEvents()
	if view.session.reloader != nil {
		view.session.reloader.SetTrace(true)
	}
	view.session.mu.Unlock()
	server, err := devui.New(devui.Options{Static: devui.Assets(), API: devui.NewAPI(view, view.session.events)})
	if err != nil {
		return nil, fmt.Errorf("%w: the UI server: %v", exitcode.ErrConfiguration, err)
	}
	uiCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := server.Serve(uiCtx); err != nil {
			progress("the UI server stopped: " + err.Error())
		}
	}()
	unregister := registerUI(view.session.manifest.Contract, server.URL())
	progress("local UI on 127.0.0.1 (the link carries this run's token; do not share it)")
	if err := browser.OpenOrPrint(cmd.OutOrStdout(), server.URL(), noBrowser); err != nil {
		progress("could not open a browser: " + err.Error())
	}
	return func() { cancel(); <-done; unregister() }, nil
}

// writerIsTerminal reports whether w is a terminal, where signet dev may
// colour and clear (#637); a variable so tests can stand in for one.
var writerIsTerminal = func(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}
