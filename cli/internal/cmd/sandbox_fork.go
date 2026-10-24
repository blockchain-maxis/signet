package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/fork"
	"github.com/blockchain-maxis/signet/cli/internal/rpc"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

func newSandboxForkCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "fork <contract>",
		Short: "Pin a fork of a deployed contract at the network's latest ledger",
		Long: `Pin a fork of a deployed contract at the network's latest ledger and cache
what a session needs to start: the contract's instance, its executable, and
the network's configuration. Later commands on the same fork read from the
cache instead of the network.

Forking is the first step of every sandbox session; run it alone to warm the
cache, or to see what a session will run against. --json prints the fork's
manifest.`,
		Example: `  signet sandbox fork CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN
  signet sandbox fork CC… --network mainnet --rpc-url https://my-rpc.example`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			if err := requireContract(args[0]); err != nil {
				return err
			}
			mode, err := driftMode(cmd)
			if err != nil {
				return err
			}
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt)
			defer stop()

			printer := printerFor(cmd)
			network, err := sandboxNetwork(cmd, deps)
			if err != nil {
				return err
			}
			m, err := forkWithDrift(ctx, deps, network, args[0], mode, printer.Progress)
			if err != nil {
				return err
			}
			now := time.Now
			if deps.Now != nil {
				now = deps.Now
			}
			return printer.Result(m, func(w io.Writer) error {
				_, err := fmt.Fprintln(w, describeFork(m, now()))
				return err
			})
		},
	}
}

// sandboxNetwork resolves the network a sandbox command forks from: the
// root's --network, then --rpc-url / --network-passphrase and the context's
// rpc-url.
func sandboxNetwork(cmd *cobra.Command, deps Deps) (rpc.Network, error) {
	rpcURL, _ := cmd.Flags().GetString("rpc-url")
	passphrase, _ := cmd.Flags().GetString("network-passphrase")
	return rpc.Select(rpc.Selection{
		Network:      deps.Config.Network,
		RPCURL:       rpcURL,
		ConfigRPCURL: deps.Config.RPCURL,
		Passphrase:   passphrase,
	})
}

// startSimulator finds and starts signet-simulator.
func startSimulator(ctx context.Context, deps Deps, warn func(string)) (*simulator.Client, error) {
	locate := deps.LocateSimulator
	if locate == nil {
		locate = simulator.Find
	}
	path, err := locate(ctx, deps.Version, warn)
	if err != nil {
		return nil, err
	}
	return simulator.Start(ctx, path, deps.SimulatorOptions...)
}

// createFork pins a fork of contract at the network's latest ledger: reads
// the ledger, opens it in the simulator (which fetches the network config),
// and reads the contract through contract_info (which fetches its instance
// and code), all through the fork's cache. It returns the saved manifest.
// forkWithDrift creates a fork and applies the --drift mode to what it
// fetched (#551).
func forkWithDrift(ctx context.Context, deps Deps, network rpc.Network, contract, mode string, progress func(string)) (fork.Manifest, error) {
	m, drift, err := createFork(ctx, deps, network, contract, progress)
	if err != nil || drift.Count() == 0 {
		return m, err
	}
	switch mode {
	case "fail":
		return fork.Manifest{}, fmt.Errorf("%w: %s — run with --drift=refork to pin a newer ledger, or --drift=warn to accept it",
			exitcode.ErrNetwork, drift.Warning())
	case "refork":
		progress(drift.Warning() + "; forking again at the latest ledger")
		if m, drift, err = createFork(ctx, deps, network, contract, progress); err != nil {
			return fork.Manifest{}, err
		}
		if drift.Count() > 0 {
			progress(drift.Warning())
		}
	default:
		progress(drift.Warning())
	}
	return m, nil
}

func createFork(ctx context.Context, deps Deps, network rpc.Network, contract string, progress func(string)) (m fork.Manifest, drift fork.Drift, err error) {
	client, _, err := rpc.Connect(ctx, network, deps.RPCOptions...)
	if err != nil {
		return fork.Manifest{}, fork.Drift{}, err
	}
	latest, err := client.GetLatestLedger(ctx)
	if err != nil {
		return fork.Manifest{}, fork.Drift{}, err
	}

	sim, err := startSimulator(ctx, deps, progress)
	if err != nil {
		return fork.Manifest{}, fork.Drift{}, err
	}
	defer func() { _ = sim.Close() }()
	if err := checkLanes(network.Name, latest.ProtocolVersion, sim.HelloAck()); err != nil {
		return fork.Manifest{}, fork.Drift{}, err
	}

	rootDir := deps.ForkRoot
	if rootDir == nil {
		rootDir = fork.Root
	}
	root, err := rootDir()
	if err != nil {
		return fork.Manifest{}, fork.Drift{}, err
	}
	forkTime := closeTime(latest.CloseTime, deps.Now)
	m = fork.Manifest{
		Network:    network.Name,
		Passphrase: network.Passphrase,
		RPCURL:     network.RPCURL,
		Contract:   contract,
		ForkLedger: latest.Sequence,
		ForkTime:   forkTime,
		Protocol:   latest.ProtocolVersion,
		Lanes:      []int{latest.ProtocolVersion},
	}
	cache, err := fork.Create(root, m)
	if err != nil {
		return fork.Manifest{}, fork.Drift{}, err
	}
	saved := false
	defer func() {
		_ = cache.Close()
		if !saved {
			// A fork of nothing (no such contract) is not worth keeping.
			_ = os.RemoveAll(cache.Dir())
		}
	}()
	fetcher := &fork.Fetcher{Ctx: ctx, Cache: cache, RPC: client, ForkLedger: latest.Sequence}
	sim.HandleFetch(fetcher.Fetch)

	protocol := latest.ProtocolVersion
	sequence := latest.Sequence
	timestamp := uint64(forkTime.Unix())
	if _, err := callSimulator(ctx, sim, simulator.TypeLedgerOpen, simulator.LedgerOpenParams{
		NetworkPassphrase: network.Passphrase,
		LedgerProtocol:    &protocol,
		Sequence:          &sequence,
		Timestamp:         &timestamp,
	}, nil); err != nil {
		return fork.Manifest{}, fork.Drift{}, err
	}

	var info simulator.ContractInfoResult
	if _, err := callSimulator(ctx, sim, simulator.TypeContractInfo, simulator.ContractInfoParams{ContractID: contract}, &info); err != nil {
		var se *simulator.Error
		if errors.As(err, &se) && se.Code == "bad_request" && se.Detail["path"] == "contract_id" {
			return fork.Manifest{}, fork.Drift{}, &inputError{fmt.Sprintf("no contract %s on %s at ledger %d: %s", contract, network.Name, latest.Sequence, se.Message)}
		}
		return fork.Manifest{}, fork.Drift{}, err
	}
	m.Executable = info.Executable
	if info.WasmHash != nil {
		m.WasmHash = *info.WasmHash
	}
	m.InstanceStorageEntries = info.StorageEntries
	drift = fetcher.Drift()
	m.DriftedEntries = drift.Count()
	if err := cache.SaveManifest(m); err != nil {
		return fork.Manifest{}, fork.Drift{}, err
	}
	saved = true
	return m, drift, nil
}

// callSimulator is Call for requests that cannot fail as a contract: a
// contract_error here would be a simulator bug, so it is reported as one.
func callSimulator(ctx context.Context, sim *simulator.Client, typ string, params, result any) (*simulator.ContractError, error) {
	ce, err := sim.Call(ctx, typ, params, result)
	if err == nil && ce != nil {
		return nil, &simulator.Error{Code: ce.Code, Message: fmt.Sprintf("%s answered with a contract error: %s", typ, ce.Message)}
	}
	return ce, err
}

// checkLanes refuses a network running a ledger protocol the simulator has
// no lane for (#591), before anything is fetched.
func checkLanes(network string, protocol int, ack simulator.HelloAck) error {
	var lanes []int
	for _, l := range ack.Lanes {
		lanes = append(lanes, l.LedgerProtocol)
	}
	if slices.Contains(lanes, protocol) {
		return nil
	}
	have := make([]string, len(lanes))
	for i, l := range lanes {
		have[i] = strconv.Itoa(l)
	}
	return fmt.Errorf("%w: %s runs ledger protocol %d, but this signet-simulator runs %s — install a signet-cli release with a protocol %d lane",
		exitcode.ErrHostUnsupported, network, protocol, strings.Join(have, ", "), protocol)
}

// closeTime reads getLatestLedger's closeTime (Unix seconds), falling back
// to now for an RPC that does not report it.
func closeTime(raw string, now func() time.Time) time.Time {
	if secs, err := strconv.ParseInt(raw, 10, 64); err == nil && secs > 0 {
		return time.Unix(secs, 0).UTC()
	}
	if now == nil {
		now = time.Now
	}
	return now().UTC().Truncate(time.Second)
}

// describeFork is the one-line human summary of a fork.
func describeFork(m fork.Manifest, now time.Time) string {
	parts := []string{fmt.Sprintf("Forked %s on %s at ledger %d (protocol %d, %s)",
		shorten(m.Contract, 4, 3), m.Network, m.ForkLedger, m.Protocol, ago(now.Sub(m.ForkTime)))}
	switch m.Executable {
	case "stellar_asset":
		parts = append(parts, "Stellar Asset Contract")
	default:
		if m.WasmHash != "" {
			parts = append(parts, "wasm "+shorten(m.WasmHash, 4, 2))
		}
	}
	noun := "entries"
	if m.InstanceStorageEntries == 1 {
		noun = "entry"
	}
	parts = append(parts, fmt.Sprintf("instance storage %d %s", m.InstanceStorageEntries, noun))
	return strings.Join(parts, " · ")
}

func shorten(s string, head, tail int) string {
	if len(s) <= head+tail+1 {
		return s
	}
	return s[:head] + "…" + s[len(s)-tail:]
}

func ago(d time.Duration) string {
	switch {
	case d < time.Second:
		return "just now"
	case d < time.Minute:
		return fmt.Sprintf("%ds ago", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}
