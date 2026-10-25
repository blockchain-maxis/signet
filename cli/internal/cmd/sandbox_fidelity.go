package cmd

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/fork"
	"github.com/blockchain-maxis/signet/cli/internal/rpc"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// newSandboxFidelityCmd is `signet sandbox fidelity` (#575): the same calls
// through the local host and through the network's own simulateTransaction,
// compared. The nightly sandbox-fidelity workflow runs it on testnet.
func newSandboxFidelityCmd() *cobra.Command {
	var (
		calls          []string
		feeTolerance   float64
		summary        string
		ledgerProtocol int
	)
	cmd := &cobra.Command{
		Use:   "fidelity <contract> --call <function>[=<json args>]...",
		Short: "Compare the local host with the network's simulateTransaction",
		Long: `Run each --call through the local host (on a fork, as signet sandbox call
does) and through the RPC's own simulateTransaction, and compare: the return
value, the auth entries (who signs for which invocation, nonces aside), the
footprint's read-only and read-write key sets, and the resource fee within
--fee-tolerance percent. Any difference is listed and exits 10.

--summary appends a Markdown table (for $GITHUB_STEP_SUMMARY).
--ledger-protocol runs the local side on another lane, to see a wrong lane
show up as differences.`,
		Example: `  signet sandbox fidelity CASF…RCN --network testnet --call count \
    --call 'resolve={"handle":"aquawolf"}'`,
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
			if len(calls) == 0 {
				return &inputError{"signet sandbox fidelity needs at least one --call"}
			}
			type call struct {
				function string
				args     map[string]any
			}
			var parsed []call
			for _, c := range calls {
				fn, raw, has := strings.Cut(c, "=")
				a := map[string]any{}
				if has {
					if err := json.Unmarshal([]byte(raw), &a); err != nil {
						return &inputError{fmt.Sprintf("--call %s: the arguments must be a JSON object: %v", fn, err)}
					}
				}
				parsed = append(parsed, call{fn, a})
			}
			network, err := sandboxNetwork(cmd, deps)
			if err != nil {
				return err
			}
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt)
			defer stop()
			printer := printerFor(cmd)
			client, _, err := rpc.Connect(ctx, network, deps.RPCOptions...)
			if err != nil {
				return err
			}

			var reports []fidelityReport
			for _, c := range parsed {
				ours, _, err := runCall(ctx, deps, network, callRequest{
					contract: contract, function: c.function, args: c.args, authMode: "record", protocol: ledgerProtocol,
					// Padded as simulateTransaction pads, so the fees compare.
					adjustment: "rpc",
				}, printer.Progress)
				if err != nil {
					return err
				}
				r, err := compareWithRPC(ctx, deps, network, client, contract, c.function, c.args, ours, feeTolerance)
				if err != nil {
					return err
				}
				reports = append(reports, r)
			}
			if summary != "" {
				if err := appendSummary(summary, contract, network.Name, reports); err != nil {
					return fmt.Errorf("%w: --summary: %v", exitcode.ErrConfiguration, err)
				}
			}
			var failed []string
			for _, r := range reports {
				if !r.Match {
					failed = append(failed, r.Call)
				}
			}
			if err := printer.Result(struct {
				Contract string           `json:"contract"`
				Network  string           `json:"network"`
				Calls    []fidelityReport `json:"calls"`
				Match    bool             `json:"match"`
			}{contract, network.Name, reports, len(failed) == 0}, func(w io.Writer) error {
				for _, r := range reports {
					mark := "✓"
					if !r.Match {
						mark = "✗ " + strings.Join(r.Differences, "; ")
					}
					if _, err := fmt.Fprintf(w, "  %s  fee %d local, %d RPC  %s\n", r.Call, r.Local.ResourceFee, r.RPC.ResourceFee, mark); err != nil {
						return err
					}
				}
				return nil
			}); err != nil {
				return err
			}
			if len(failed) > 0 {
				return fmt.Errorf("%w: the local host and simulateTransaction differ on %s", exitcode.ErrDiffFound, strings.Join(failed, ", "))
			}
			return nil
		},
	}
	addRPCFlags(cmd)
	cmd.Flags().StringArrayVar(&calls, "call", nil, "a call to compare: <function> or <function>=<json args>; repeatable")
	cmd.Flags().Float64Var(&feeTolerance, "fee-tolerance", 10, "how far apart the resource fees may be, in percent")
	cmd.Flags().StringVar(&summary, "summary", "", "append a Markdown summary to this file")
	cmd.Flags().IntVar(&ledgerProtocol, "ledger-protocol", 0, "run the local side on this lane instead of the fork's")
	return cmd
}

// fidelitySide is what one simulator said about a call.
type fidelitySide struct {
	Outcome        string   `json:"outcome"` // ok or error
	Error          string   `json:"error,omitempty"`
	ReturnValueXDR string   `json:"returnValueXdr,omitempty"`
	Auth           []string `json:"auth"`
	ReadOnly       []string `json:"readOnly"`
	ReadWrite      []string `json:"readWrite"`
	ResourceFee    int64    `json:"resourceFee"`
}

// fidelityReport is one call compared.
type fidelityReport struct {
	Call        string       `json:"call"`
	Match       bool         `json:"match"`
	Differences []string     `json:"differences"`
	Local       fidelitySide `json:"local"`
	RPC         fidelitySide `json:"rpc"`
}

// rpcSimulation is the part of simulateTransaction's answer compared.
type rpcSimulation struct {
	Error           string `json:"error"`
	TransactionData string `json:"transactionData"`
	MinResourceFee  string `json:"minResourceFee"`
	Results         []struct {
		XDR  string   `json:"xdr"`
		Auth []string `json:"auth"`
	} `json:"results"`
}

// compareWithRPC builds the call's envelope on a fork session, has the RPC
// simulate it, and compares that with ours.
func compareWithRPC(ctx context.Context, deps Deps, network rpc.Network, client *rpc.Client, contract, function string, args map[string]any, ours CallResult, feeTolerance float64) (fidelityReport, error) {
	report := fidelityReport{Call: function, Differences: []string{}}
	local := fidelitySide{Outcome: "ok", ReturnValueXDR: ours.ReturnValueXDR, Auth: ours.Auth, ReadOnly: []string{}, ReadWrite: []string{}}
	if ours.Outcome != "result" {
		local.Outcome = "error"
		if ours.Error != nil {
			local.Error = ours.Error.Code
		}
	}
	if ours.Resources != nil {
		local.ReadOnly, local.ReadWrite = ours.Resources.Footprint.ReadOnly, ours.Resources.Footprint.ReadWrite
	}
	if ours.Fee != nil {
		local.ResourceFee = ours.Fee.ResourceFee
	}

	sim, cleanup, err := forkSimulator(ctx, deps, network, client, contract)
	if err != nil {
		return report, err
	}
	defer cleanup()
	var envelope simulator.TxEnvelopeResult
	if _, err := callSimulator(ctx, sim, simulator.TypeTxEnvelope, simulator.TxEnvelopeParams{ContractID: contract, Function: function, Args: args}, &envelope); err != nil {
		return report, err
	}
	raw, err := client.SimulateTransaction(ctx, envelope.TransactionXDR)
	if err != nil {
		return report, err
	}
	var answer rpcSimulation
	if err := json.Unmarshal(raw, &answer); err != nil {
		return report, fmt.Errorf("%w: simulateTransaction's answer: %v", exitcode.ErrNetwork, err)
	}
	remote := fidelitySide{Outcome: "ok", Auth: []string{}, ReadOnly: []string{}, ReadWrite: []string{}}
	if answer.Error != "" {
		remote.Outcome, remote.Error = "error", answer.Error
	} else {
		if len(answer.Results) > 0 {
			remote.ReturnValueXDR, remote.Auth = answer.Results[0].XDR, answer.Results[0].Auth
		}
		var res simulator.TxResourcesResult
		if _, err := callSimulator(ctx, sim, simulator.TypeTxResources, simulator.TxResourcesParams{TransactionDataXDR: answer.TransactionData}, &res); err != nil {
			return report, err
		}
		remote.ReadOnly, remote.ReadWrite = res.ReadOnly, res.ReadWrite
		remote.ResourceFee, _ = strconv.ParseInt(answer.MinResourceFee, 10, 64)
	}
	report.Local, report.RPC = local, remote

	differ := func(format string, a ...any) {
		report.Differences = append(report.Differences, fmt.Sprintf(format, a...))
	}
	switch {
	case local.Outcome != remote.Outcome:
		outcome := func(s fidelitySide) string {
			if s.Error != "" {
				return s.Outcome + " (" + s.Error + ")"
			}
			return s.Outcome
		}
		differ("outcome: local %s, RPC %s", outcome(local), outcome(remote))
	case local.Outcome == "ok":
		if local.ReturnValueXDR != remote.ReturnValueXDR {
			differ("return value: local %s, RPC %s", local.ReturnValueXDR, remote.ReturnValueXDR)
		}
		// Auth by who signs for what: the nonces and expirations are each
		// simulator's own.
		var d simulator.DiffResultsResult
		if _, err := callSimulator(ctx, sim, simulator.TypeDiffResults, simulator.DiffResultsParams{
			A: simulator.DiffSide{Outcome: "ok", ReturnValueXDR: local.ReturnValueXDR, Auth: local.Auth},
			B: simulator.DiffSide{Outcome: "ok", ReturnValueXDR: remote.ReturnValueXDR, Auth: remote.Auth},
		}, &d); err != nil {
			return report, err
		}
		if n := len(d.Auth.Added) + len(d.Auth.Removed) + len(d.Auth.Changed); n > 0 {
			differ("auth: %d entries differ (local %d, RPC %d)", n, len(local.Auth), len(remote.Auth))
		}
		for _, set := range []struct {
			name        string
			local, root []string
		}{{"read-only footprint", local.ReadOnly, remote.ReadOnly}, {"read-write footprint", local.ReadWrite, remote.ReadWrite}} {
			// An auth nonce key is each simulator's own draw.
			if only, other := setDifference(withoutNonces(set.local), withoutNonces(set.root)), setDifference(withoutNonces(set.root), withoutNonces(set.local)); len(only)+len(other) > 0 {
				differ("%s: %d keys only local, %d only RPC", set.name, len(only), len(other))
			}
		}
		if remote.ResourceFee > 0 {
			off := 100 * math.Abs(float64(local.ResourceFee-remote.ResourceFee)) / float64(remote.ResourceFee)
			if off > feeTolerance {
				differ("resource fee: local %d, RPC %d (%.1f%% apart, tolerance %.0f%%)", local.ResourceFee, remote.ResourceFee, off, feeTolerance)
			}
		}
	}
	report.Match = len(report.Differences) == 0
	return report, nil
}

func setDifference(a, b []string) []string {
	in := map[string]bool{}
	for _, k := range b {
		in[k] = true
	}
	var out []string
	for _, k := range a {
		if !in[k] {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// forkSimulator opens the contract's newest fork in a fresh simulator, for
// the helper verbs that need the contract's spec.
func forkSimulator(ctx context.Context, deps Deps, network rpc.Network, client *rpc.Client, contract string) (*simulator.Client, func(), error) {
	root, err := forkRoot(deps)
	if err != nil {
		return nil, nil, err
	}
	info, err := latestFork(root, network, contract)
	if err != nil || info == nil {
		return nil, nil, fmt.Errorf("%w: no fork of %s: %v", exitcode.ErrConfiguration, contract, err)
	}
	cache, err := fork.Open(root, network.Passphrase, info.ID)
	if err != nil {
		return nil, nil, err
	}
	sim, err := startSimulator(ctx, deps, func(string) {})
	if err != nil {
		_ = cache.Close()
		return nil, nil, err
	}
	cleanup := func() {
		_ = sim.Close()
		_ = cache.Close()
	}
	m := cache.Manifest()
	sim.HandleFetch((&fork.Fetcher{Ctx: ctx, Cache: cache, RPC: client, ForkLedger: m.ForkLedger}).Fetch)
	protocol, sequence, timestamp := m.Protocol, m.ForkLedger, uint64(m.ForkTime.Unix())
	if _, err := callSimulator(ctx, sim, simulator.TypeLedgerOpen, simulator.LedgerOpenParams{
		NetworkPassphrase: m.Passphrase, LedgerProtocol: &protocol, Sequence: &sequence, Timestamp: &timestamp,
	}, nil); err != nil {
		cleanup()
		return nil, nil, err
	}
	return sim, cleanup, nil
}

// appendSummary appends the reports as a Markdown table.
func appendSummary(path, contract, network string, reports []fidelityReport) error {
	var b strings.Builder
	fmt.Fprintf(&b, "## Sandbox fidelity: `%s` on %s\n\n| call | local fee | RPC fee | result |\n| --- | ---: | ---: | --- |\n", contract, network)
	for _, r := range reports {
		result := "✓ agrees"
		if !r.Match {
			result = "✗ " + strings.Join(r.Differences, "<br>")
		}
		fmt.Fprintf(&b, "| `%s` | %d | %d | %s |\n", r.Call, r.Local.ResourceFee, r.RPC.ResourceFee, result)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(b.String() + "\n"); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

// withoutNonces drops auth nonce keys: a ContractData LedgerKey whose key
// is an ScVal LEDGER_KEY_NONCE (discriminant 21). The nonce is random in
// RPC's recording auth and seeded in the local host, so the keys differ
// by design.
func withoutNonces(keys []string) []string {
	var out []string
	for _, k := range keys {
		if !isNonceKey(k) {
			out = append(out, k)
		}
	}
	return out
}

func isNonceKey(b64 string) bool {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(raw) < 8 || binary.BigEndian.Uint32(raw) != 6 { // CONTRACT_DATA
		return false
	}
	at := 4
	// ScAddress: an account (type, ed25519 key) or a contract (hash).
	switch binary.BigEndian.Uint32(raw[at:]) {
	case 0:
		at += 4 + 4 + 32
	case 1:
		at += 4 + 32
	default:
		return false
	}
	return len(raw) >= at+4 && binary.BigEndian.Uint32(raw[at:]) == 21 // SCV_LEDGER_KEY_NONCE
}
