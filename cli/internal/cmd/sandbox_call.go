package cmd

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/devconfig"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/fork"
	"github.com/blockchain-maxis/signet/cli/internal/render"
	"github.com/blockchain-maxis/signet/cli/internal/rpc"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// CallResult is `signet sandbox call --json`: one object, schema in
// sandbox/protocol/schema/v1/cli-call-result.json.
type CallResult struct {
	Contract      string         `json:"contract"`
	Function      string         `json:"function"`
	Args          map[string]any `json:"args"`
	SourceAccount string         `json:"sourceAccount,omitempty"`
	Network       string         `json:"network"`
	ForkID        string         `json:"forkId"`
	ForkLedger    uint32         `json:"forkLedger"`
	Protocol      int            `json:"protocol"`
	Session       string         `json:"session,omitempty"`
	SwappedWasm   string         `json:"swappedWasm,omitempty"`
	// Outcome is "result" (the call returned) or "contract_error" (the
	// contract or the host refused it).
	Outcome        string                    `json:"outcome"`
	ReturnValue    json.RawMessage           `json:"returnValue,omitempty"`
	ReturnValueXDR string                    `json:"returnValueXdr,omitempty"`
	Error          *simulator.ContractError  `json:"error,omitempty"`
	Events         []simulator.Event         `json:"events"`
	Auth           []string                  `json:"auth"`
	AuthEntries    []simulator.AuthEntry     `json:"authEntries"`
	Modified       []simulator.ModifiedEntry `json:"modifiedEntries"`
	Resources      *simulator.Resources      `json:"resources,omitempty"`
	Fee            *simulator.Fee            `json:"fee,omitempty"`
	Cost           *simulator.Cost           `json:"cost,omitempty"`
	Misses         []string                  `json:"misses"`
	Drift          fork.Drift                `json:"drift"`
	Seed           string                    `json:"seed"`
	// ForkTime is when the fork ledger closed.
	ForkTime time.Time `json:"forkTime"`
	// AuthMode is how require_auth was answered: record, strict, enforce.
	AuthMode string `json:"authMode"`
	// Ledger is the ledger the call ran at; Overridden when --ledger-seq,
	// --timestamp or --advance moved it off the fork's (#558).
	Ledger *simulator.LedgerInfo `json:"ledger,omitempty"`
	// Budget is the limits a call ran under when --unlimited or
	// --budget-instructions overrode the network's.
	Budget    *simulator.Budget `json:"budget,omitempty"`
	Unlimited bool              `json:"unlimited,omitempty"`
	// Archived are the archived entries the call read.
	Archived []simulator.Archived `json:"archived,omitempty"`
	// Contracts are the other contracts the call reached (#552).
	Contracts []simulator.RelatedContract `json:"contracts"`
	// StorageOverrides are the keys --set-storage, --unset-storage and
	// --overrides changed for this call (#559), in words.
	StorageOverrides []string `json:"storageOverrides,omitempty"`
}

func newSandboxCallCmd() *cobra.Command {
	var (
		rawArgs       []string
		argsFile      string
		sourceAccount string
		wasmPath      string
		session       string
		authMode      string
		authFile      string
		ledgerSeq     uint32
		timestamp     string
		advance       string
		unlimited     bool
		instructions  uint64
		noRelated     bool
		setStorage    []string
		unsetStorage  []string
		overridesFile string
		save          string
	)
	cmd := &cobra.Command{
		Use:   "call <contract> <function>",
		Short: "Call a contract function on a fork, locally",
		Long: `Call a function of a deployed contract on a fork of the network, in the local
contract simulator. Nothing is submitted: the result says what the call would
return, write and require, at the fork's ledger.

Arguments are named: --arg handle=alice --arg wallet=G…. A value is read as
JSON when it parses as JSON and as a plain string otherwise, so --arg n=5 is
the number 5 and --arg handle=alice the string "alice"; quote a string that
looks like JSON (--arg name='"5"'). --args-file takes a JSON object instead.

Without --session every call starts from the fork. With --session <name>, the
call's writes are kept in the fork cache and the next call with the same name
starts from them; signet sandbox session reset <name> clears them.

The account a call runs as is --source-account (a G… address), not the root's
--source, which names the stellar identity signet signs with.

Time-dependent logic is tested by moving the ledger for the call:
--ledger-seq and --timestamp set it, --advance moves both from the fork's
(30d, 12h, or +N ledgers; one ledger is taken as the network's nominal 5s, an
approximation). An entry whose TTL runs out on the way reads as archived: the
call restores it, as the network does from protocol 23, and says which.
--unlimited lifts the budget to the sandbox's ceiling (10x the network's),
--budget-instructions sets the instruction limit. Every override shows in the
result's footer.`,
		Example: `  signet sandbox call CASF…RCN count
  signet sandbox call CASF…RCN claim --arg handle=alice --arg wallet=GA5Z… --session demo
  signet sandbox call CASF…RCN resolve --arg handle=alice --session demo
  signet sandbox call CASF…RCN count --wasm ./target/wasm32v1-none/release/registry.wasm
  signet sandbox call CASF…RCN claim --arg unlock_time=1790000000 --advance 30d`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			contract, function := args[0], args[1]
			if err := requireContract(contract); err != nil {
				return err
			}
			mode, err := driftMode(cmd)
			if err != nil {
				return err
			}
			callArgs, err := parseCallArgs(rawArgs, argsFile)
			if err != nil {
				return err
			}
			req := callRequest{authMode: authMode}
			switch authMode {
			case "record", "strict":
				if authFile != "" {
					return &inputError{"--auth-entries goes with --auth enforce"}
				}
			case "enforce":
				if authFile == "" {
					return &inputError{"--auth enforce needs --auth-entries <file.json>: pre-signed entries, e.g. from stellar"}
				}
				raw, err := os.ReadFile(authFile)
				if err != nil {
					return &inputError{fmt.Sprintf("--auth-entries: %v", err)}
				}
				if err := json.Unmarshal(raw, &req.authEntries); err != nil {
					return &inputError{fmt.Sprintf("--auth-entries %s: want a JSON array of base64 SorobanAuthorizationEntry: %v", authFile, err)}
				}
			default:
				return &inputError{"--auth must be record, strict or enforce, not " + strconv.Quote(authMode)}
			}
			move, err := parseLedgerMove(cmd, ledgerSeq, timestamp, advance)
			if err != nil {
				return err
			}
			req.move = move
			if cmd.Flags().Changed("budget-instructions") && instructions == 0 {
				return &inputError{"--budget-instructions must be at least 1"}
			}
			if unlimited || instructions > 0 {
				req.budget = &simulator.Budget{Instructions: instructions, Unlimited: unlimited}
			}
			var wasm []byte
			if wasmPath != "" {
				if wasm, err = os.ReadFile(wasmPath); err != nil {
					return &inputError{fmt.Sprintf("--wasm: %v", err)}
				}
			}
			// --save needs a signet.dev.toml to append to: find it before
			// the call runs, and write nothing when there is none (#561).
			devFile := ""
			if cmd.Flags().Changed("save") {
				cwd, err := os.Getwd()
				if err != nil {
					return err
				}
				if devFile = devconfig.Find(cwd); devFile == "" {
					return &inputError{fmt.Sprintf("--save: no %s in %s or any directory above; signet dev init %s writes one", devconfig.FileName, cwd, contract)}
				}
			}
			network, err := sandboxNetwork(cmd, deps)
			if err != nil {
				return err
			}
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt)
			defer stop()

			printer := printerFor(cmd)
			req.contract, req.function, req.args = contract, function, callArgs
			req.sourceAccount, req.wasm, req.session = sourceAccount, wasm, session
			req.noRelated = noRelated
			if req.overrides, err = parseStorageOverrides(setStorage, unsetStorage, overridesFile); err != nil {
				return err
			}
			res, drift, err := runCall(ctx, deps, network, req, printer.Progress)
			if err != nil {
				return err
			}
			if drift.Count() > 0 {
				switch mode {
				case "fail":
					return fmt.Errorf("%w: %s — run with --drift=refork to pin a newer ledger, or --drift=warn to accept it",
						exitcode.ErrNetwork, drift.Warning())
				case "refork":
					printer.Progress(drift.Warning() + "; forking again at the latest ledger and calling once more")
					if _, err := forkWithDrift(ctx, deps, network, contract, "warn", printer.Progress); err != nil {
						return err
					}
					if res, drift, err = runCall(ctx, deps, network, req, printer.Progress); err != nil {
						return err
					}
					if drift.Count() > 0 {
						printer.Progress(drift.Warning())
					}
				default:
					printer.Progress(drift.Warning())
				}
			}
			if devFile != "" {
				name, err := saveCall(devFile, save, function, callArgs)
				if err != nil {
					return err
				}
				printer.Progress(fmt.Sprintf("Saved %q to %s (expect unchanged).", name, devFile))
			}
			return printer.Result(res, func(w io.Writer) error {
				return render.Render(w, callView(res), callProvenance(res), now(deps), render.StyleFor(cmd.OutOrStdout()))
			})
		},
	}
	cmd.Flags().StringVar(&save, "save", "", "append this call to signet.dev.toml as a [[call]] expected unchanged, under a name (default: the function's)")
	cmd.Flags().Lookup("save").NoOptDefVal = saveDefaultName
	cmd.Flags().StringArrayVar(&rawArgs, "arg", nil, "a named argument, name=value (JSON, or a plain string); repeat for each")
	cmd.Flags().StringVar(&argsFile, "args-file", "", "a JSON file holding an object of named arguments")
	cmd.Flags().StringVar(&sourceAccount, "source-account", "", "the account (G…) the call runs as")
	cmd.Flags().StringVar(&wasmPath, "wasm", "", "swap this local WASM in first, as an upgrade would, keeping storage")
	cmd.Flags().StringVar(&session, "session", "", "keep this call's writes under a name, and start from that name's earlier writes")
	cmd.Flags().StringVar(&authMode, "auth", "record", "how require_auth is answered: record (approve and list it; signatures unchecked), strict (also refuse auth below the root call), enforce (check --auth-entries)")
	cmd.Flags().StringVar(&authFile, "auth-entries", "", "with --auth enforce: a JSON array of pre-signed base64 SorobanAuthorizationEntry")
	cmd.Flags().Uint32Var(&ledgerSeq, "ledger-seq", 0, "run the call at this ledger sequence")
	cmd.Flags().StringVar(&timestamp, "timestamp", "", "run the call at this ledger close time (Unix seconds or RFC 3339)")
	cmd.Flags().StringVar(&advance, "advance", "", "move the ledger forward from the fork's: a duration (30d, 12h, 90m) or +N ledgers, at a nominal 5s per ledger")
	cmd.Flags().BoolVar(&unlimited, "unlimited", false, "run under the sandbox's budget ceiling (10x the network's limits)")
	cmd.Flags().Uint64Var(&instructions, "budget-instructions", 0, "run under this CPU instruction limit (up to 10x the network's)")
	cmd.Flags().BoolVar(&noRelated, "no-related", false, "keep the run to this contract: reaching any other contract is an error")
	cmd.Flags().StringArrayVar(&setStorage, "set-storage", nil, "override a storage entry for this call: <instance|persistent|temporary>:<key>=<value>; repeat for each")
	cmd.Flags().StringArrayVar(&unsetStorage, "unset-storage", nil, "remove a storage entry for this call: <instance|persistent|temporary>:<key>; repeat for each")
	cmd.Flags().StringVar(&overridesFile, "overrides", "", "a TOML file of [[override]] tables (durability, key, value or unset = true), as in signet.dev.toml")
	return cmd
}

// nominalClose is the network's target ledger close time. Real closes vary,
// so --advance's ledger count for a duration is an approximation.
const nominalClose = 5 * time.Second

// ledgerMove is where --ledger-seq, --timestamp and --advance put a call,
// resolved against the fork's ledger once it is known.
type ledgerMove struct {
	sequence  *uint32
	timestamp *time.Time
	// advanceLedgers and advanceBy are --advance, in both terms.
	advanceLedgers uint32
	advanceBy      time.Duration
	advance        bool
}

func parseLedgerMove(cmd *cobra.Command, seq uint32, timestamp, advance string) (ledgerMove, error) {
	var m ledgerMove
	if cmd.Flags().Changed("ledger-seq") {
		if seq == 0 {
			return m, &inputError{"--ledger-seq must be at least 1"}
		}
		m.sequence = &seq
	}
	if timestamp != "" {
		t, err := parseTimestamp(timestamp)
		if err != nil {
			return m, err
		}
		m.timestamp = &t
	}
	if advance == "" {
		return m, nil
	}
	if m.sequence != nil || m.timestamp != nil {
		return m, &inputError{"--advance moves the fork's ledger; it does not combine with --ledger-seq or --timestamp"}
	}
	m.advance = true
	if n, ok := strings.CutPrefix(advance, "+"); ok {
		ledgers, err := strconv.ParseUint(n, 10, 32)
		if err != nil || ledgers == 0 {
			return m, &inputError{fmt.Sprintf("--advance %q: want +N ledgers, N at least 1", advance)}
		}
		m.advanceLedgers = uint32(ledgers)
		m.advanceBy = time.Duration(ledgers) * nominalClose
		return m, nil
	}
	d, err := parseSpan(advance)
	if err != nil || d < nominalClose {
		return m, &inputError{fmt.Sprintf("--advance %q: want a duration of at least 5s (30d, 12h, 90m) or +N ledgers", advance)}
	}
	m.advanceBy = d
	m.advanceLedgers = uint32(min(int64(d/nominalClose), int64(^uint32(0))))
	return m, nil
}

// parseTimestamp reads Unix seconds or RFC 3339.
func parseTimestamp(s string) (time.Time, error) {
	if n, err := strconv.ParseUint(s, 10, 63); err == nil {
		return time.Unix(int64(n), 0).UTC(), nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil || t.Unix() < 0 {
		return time.Time{}, &inputError{fmt.Sprintf("--timestamp %q: want Unix seconds or RFC 3339 (2026-11-24T00:00:00Z)", s)}
	}
	return t.UTC(), nil
}

// parseSpan is time.ParseDuration plus days and weeks: 30d, 2w, 1d12h.
func parseSpan(s string) (time.Duration, error) {
	var total time.Duration
	for _, unit := range []struct {
		suffix string
		size   time.Duration
	}{{"w", 7 * 24 * time.Hour}, {"d", 24 * time.Hour}} {
		before, after, ok := strings.Cut(s, unit.suffix)
		if !ok {
			continue
		}
		n, err := strconv.ParseUint(before, 10, 32)
		if err != nil {
			return 0, err
		}
		total += time.Duration(n) * unit.size
		s = after
	}
	if s != "" {
		d, err := time.ParseDuration(s)
		if err != nil {
			return 0, err
		}
		total += d
	}
	return total, nil
}

// at resolves the move against the fork's ledger, or nil for none.
func (m ledgerMove) at(forkLedger uint32, forkTime time.Time) *simulator.LedgerOverride {
	var o simulator.LedgerOverride
	switch {
	case m.advance:
		seq := uint32(min(uint64(forkLedger)+uint64(m.advanceLedgers), uint64(^uint32(0))))
		ts := uint64(forkTime.Add(m.advanceBy).Unix())
		o.Sequence, o.Timestamp = &seq, &ts
	case m.sequence != nil || m.timestamp != nil:
		o.Sequence = m.sequence
		if m.timestamp != nil {
			ts := uint64(m.timestamp.Unix())
			o.Timestamp = &ts
		}
	default:
		return nil
	}
	return &o
}

// saveDefaultName is what a bare --save holds: name the call after its
// function.
const saveDefaultName = "\x00"

// saveCall appends the call to the signet.dev.toml at path (#561): its
// function and its arguments as they were parsed, expected unchanged. A
// bare --save names it after the function, numbered if that is taken.
func saveCall(path, name, function string, args map[string]any) (string, error) {
	if name == saveDefaultName {
		existing, err := devconfig.Load(path)
		if err != nil {
			return "", &inputError{err.Error()}
		}
		taken := map[string]bool{}
		for _, c := range existing.Calls {
			taken[c.Name] = true
		}
		name = function
		for n := 2; taken[name]; n++ {
			name = fmt.Sprintf("%s %d", function, n)
		}
	}
	if args == nil {
		args = map[string]any{}
	}
	call := devconfig.Call{Name: name, Function: function, Args: args, Expect: devconfig.Expect{Kind: "unchanged"}}
	if err := devconfig.AppendCall(path, call); err != nil {
		return "", &inputError{"--save: " + err.Error()}
	}
	return name, nil
}

// parseCallArgs reads --arg name=value and --args-file into one object.
func parseCallArgs(raw []string, file string) (map[string]any, error) {
	args := map[string]any{}
	if file != "" {
		data, err := os.ReadFile(file)
		if err != nil {
			return nil, &inputError{fmt.Sprintf("--args-file: %v", err)}
		}
		if err := json.Unmarshal(data, &args); err != nil {
			return nil, &inputError{fmt.Sprintf("--args-file %s: want a JSON object of named arguments: %v", file, err)}
		}
	}
	for _, a := range raw {
		name, value, ok := strings.Cut(a, "=")
		if !ok || name == "" {
			return nil, &inputError{fmt.Sprintf("--arg %q: want name=value", a)}
		}
		var v any
		if err := json.Unmarshal([]byte(value), &v); err != nil {
			v = value // not JSON: a plain string
		}
		args[name] = v
	}
	return args, nil
}

type callRequest struct {
	contract, function string
	args               map[string]any
	sourceAccount      string
	wasm               []byte
	session            string
	authMode           string
	authEntries        []string
	move               ledgerMove
	budget             *simulator.Budget
	noRelated          bool
	overrides          []storageOverride
	// protocol, when set, opens the ledger on that lane instead of the
	// fork's (signet sandbox fidelity --ledger-protocol, #575).
	protocol int
	// adjustment is simulate's: "rpc" pads as simulateTransaction does.
	adjustment string
}

// latestFork returns the newest fork of contract on network, if any.
func latestFork(root string, network rpc.Network, contract string) (*fork.Info, error) {
	forks, err := fork.List(root)
	if err != nil {
		return nil, err
	}
	var best *fork.Info
	for i := range forks {
		f := &forks[i]
		if f.Contract == contract && f.Passphrase == network.Passphrase && (best == nil || f.ForkLedger > best.ForkLedger) {
			best = f
		}
	}
	return best, nil
}

func sessionKey(name string) string { return "session/" + name }

// runCall runs one call on the newest fork of the contract, creating the
// fork first if there is none.
func runCall(ctx context.Context, deps Deps, network rpc.Network, req callRequest, progress func(string)) (CallResult, fork.Drift, error) {
	root, err := forkRoot(deps)
	if err != nil {
		return CallResult{}, fork.Drift{}, err
	}
	info, err := latestFork(root, network, req.contract)
	if err != nil {
		return CallResult{}, fork.Drift{}, fmt.Errorf("%w: reading the fork cache: %v", exitcode.ErrConfiguration, err)
	}
	if info == nil {
		progress(fmt.Sprintf("No fork of %s on %s yet; forking it now.", shorten(req.contract, 4, 3), network.Name))
		if _, err := forkWithDrift(ctx, deps, network, req.contract, "warn", progress); err != nil {
			return CallResult{}, fork.Drift{}, err
		}
		if info, err = latestFork(root, network, req.contract); err != nil || info == nil {
			return CallResult{}, fork.Drift{}, fmt.Errorf("%w: the new fork is not in the cache", exitcode.ErrConfiguration)
		}
	}
	if network.RPCURL == "" {
		network.RPCURL = info.RPCURL
	}
	client, _, err := rpc.Connect(ctx, network, deps.RPCOptions...)
	if err != nil {
		return CallResult{}, fork.Drift{}, err
	}

	sim, err := startSimulator(ctx, deps, progress)
	if err != nil {
		return CallResult{}, fork.Drift{}, err
	}
	defer func() { _ = sim.Close() }()
	if err := checkLanes(network.Name, info.Protocol, sim.HelloAck()); err != nil {
		return CallResult{}, fork.Drift{}, err
	}

	cache, err := fork.Open(root, network.Passphrase, info.ID)
	if err != nil {
		return CallResult{}, fork.Drift{}, err
	}
	defer func() { _ = cache.Close() }()
	fetcher := &fork.Fetcher{Ctx: ctx, Cache: cache, RPC: client, ForkLedger: info.ForkLedger}
	sim.HandleFetch(fetcher.Fetch)

	m := cache.Manifest()
	protocol, sequence, timestamp := m.Protocol, m.ForkLedger, uint64(m.ForkTime.Unix())
	if req.protocol != 0 {
		protocol = req.protocol
	}

	// A named session starts from its earlier writes.
	var saved savedSession
	if req.session != "" {
		raw, err := cache.Meta(sessionKey(req.session))
		if err != nil {
			return CallResult{}, fork.Drift{}, err
		}
		if raw != nil {
			if err := json.Unmarshal(raw, &saved); err != nil {
				return CallResult{}, fork.Drift{}, fmt.Errorf("%w: session %q in the fork cache is unreadable: %v", exitcode.ErrConfiguration, req.session, err)
			}
		}
	}

	if _, err := callSimulator(ctx, sim, simulator.TypeLedgerOpen, simulator.LedgerOpenParams{
		NetworkPassphrase: m.Passphrase, LedgerProtocol: &protocol, Sequence: &sequence, Timestamp: &timestamp,
		SessionID: req.session, CallIndex: saved.Calls,
	}, nil); err != nil {
		return CallResult{}, fork.Drift{}, err
	}
	if len(saved.Entries) > 0 {
		if _, err := callSimulator(ctx, sim, simulator.TypeLedgerApply, simulator.LedgerApplyParams{Entries: saved.Entries}, nil); err != nil {
			return CallResult{}, fork.Drift{}, err
		}
	}

	res := CallResult{
		Contract: req.contract, Function: req.function, Args: req.args, SourceAccount: req.sourceAccount,
		Network: m.Network, ForkID: info.ID, ForkLedger: m.ForkLedger, Protocol: m.Protocol, Session: req.session,
		ForkTime: m.ForkTime, AuthMode: req.authMode, Unlimited: req.budget != nil && req.budget.Unlimited,
	}
	for _, o := range req.overrides {
		var written simulator.StorageOverrideResult
		if _, err := callSimulator(ctx, sim, simulator.TypeStorageOverride, simulator.StorageOverrideParams{
			ContractID: req.contract, Durability: o.durability, Key: o.key, Value: o.value, Unset: o.unset,
		}, &written); err != nil {
			return CallResult{}, fork.Drift{}, asInputError(err, o.source)
		}
		verb := "set"
		if written.Removed {
			verb = "removed"
		}
		res.StorageOverrides = append(res.StorageOverrides, fmt.Sprintf("%s %s (%s)", o.durability, written.Key, verb))
	}
	if len(req.wasm) > 0 {
		var installed simulator.ContractInstallResult
		if _, err := callSimulator(ctx, sim, simulator.TypeContractInstall, simulator.ContractInstallParams{
			WasmBase64: base64.StdEncoding.EncodeToString(req.wasm),
		}, &installed); err != nil {
			return CallResult{}, fork.Drift{}, asInputError(err, "--wasm")
		}
		if _, err := callSimulator(ctx, sim, simulator.TypeContractSwap, simulator.ContractSwapParams{
			ContractID: req.contract, WasmHash: installed.WasmHash, Mode: "instance",
		}, nil); err != nil {
			return CallResult{}, fork.Drift{}, asInputError(err, "--wasm")
		}
		res.SwappedWasm = installed.WasmHash
	}

	// What earlier runs of this call fetched, in one batch before it starts
	// rather than one round trip at a time (#552). Best effort: a key that
	// cannot be had now is fetched, or fails, when the call reads it.
	if keys, err := fork.PrefetchKeys(root, m.Passphrase, req.contract, req.function); err == nil && len(keys) > 0 {
		_, _ = fetcher.Fetch(keys)
	}

	params := simulator.SimulateParams{
		ContractID: req.contract, Function: req.function, Args: req.args, SourceAccount: req.sourceAccount,
		AuthMode: req.authMode, AuthEntries: req.authEntries,
		Ledger: req.move.at(m.ForkLedger, m.ForkTime), Budget: req.budget, Adjustment: req.adjustment,
	}
	if req.noRelated {
		related := false
		params.Related = &related
	}
	var out simulator.SimulateResult
	ce, err := sim.Call(ctx, simulator.TypeSimulate, params, &out)
	if err != nil {
		res.ForkTime = m.ForkTime
		return CallResult{}, fork.Drift{}, renderedFailure(callError(ctx, sim, req, err), res, deps)
	}
	if ce != nil {
		res.Outcome = "contract_error"
		res.Error = ce
		res.Cost, res.Misses, res.Seed = ce.Cost, ce.Misses, ce.Seed
		res.Ledger, res.Budget, res.Archived, res.Contracts = ce.Ledger, ce.Budget, ce.Archived, ce.Contracts
		res.Events, res.Auth, res.Modified = []simulator.Event{}, []string{}, []simulator.ModifiedEntry{}
		res.AuthEntries = []simulator.AuthEntry{}
	} else {
		res.Outcome = "result"
		res.ReturnValue, res.ReturnValueXDR = out.ReturnValue, out.ReturnValueXDR
		res.Events, res.Auth, res.Modified = out.Events, out.Auth, out.ModifiedEntries
		res.AuthEntries = out.AuthEntries
		if res.AuthEntries == nil {
			res.AuthEntries = []simulator.AuthEntry{}
		}
		res.Resources, res.Fee, res.Cost, res.Misses, res.Seed = out.Resources, out.Fee, &out.Cost, out.Misses, out.Seed
		res.Ledger, res.Budget, res.Archived, res.Contracts = out.Ledger, out.Budget, out.Archived, out.Contracts
		if res.Auth == nil {
			res.Auth = []string{}
		}
		if res.Modified == nil {
			res.Modified = []simulator.ModifiedEntry{}
		}
		if req.session != "" {
			if err := saveSession(cache, req.session, saved, out.ModifiedEntries); err != nil {
				return CallResult{}, fork.Drift{}, err
			}
		}
	}
	if res.Misses == nil {
		res.Misses = []string{}
	}
	if res.Events == nil {
		res.Events = []simulator.Event{}
	}
	if res.Contracts == nil {
		res.Contracts = []simulator.RelatedContract{}
	}
	if err := recordRelated(cache, res.Contracts, progress); err != nil {
		return CallResult{}, fork.Drift{}, err
	}
	if err := fork.RememberMisses(root, m.Passphrase, req.contract, req.function, res.Misses); err != nil {
		return CallResult{}, fork.Drift{}, fmt.Errorf("%w: remembering what the call fetched: %v", exitcode.ErrConfiguration, err)
	}
	drift := fetcher.Drift()
	res.Drift = drift
	return res, drift, nil
}

// recordRelated adds the contracts a call reached to the fork's manifest,
// saying so the first time each is pulled in (#552).
func recordRelated(cache *fork.Cache, contracts []simulator.RelatedContract, progress func(string)) error {
	m := cache.Manifest()
	known := map[string]bool{}
	for _, c := range m.Contracts {
		known[c] = true
	}
	added := false
	for _, c := range contracts {
		if known[c.ContractID] {
			continue
		}
		known[c.ContractID] = true
		m.Contracts = append(m.Contracts, c.ContractID)
		added = true
		progress(fmt.Sprintf("+ pulled in %s (%s)", shorten(c.ContractID, 4, 3), relatedKind(c)))
	}
	if !added {
		return nil
	}
	return cache.SaveManifest(m)
}

// relatedKind says what a related contract is: "native SAC", "USDC SAC",
// "contract".
func relatedKind(c simulator.RelatedContract) string {
	switch c.Executable {
	case "stellar_asset":
		switch {
		case c.Asset == "native":
			return "native SAC"
		case c.Asset != "":
			code, _, _ := strings.Cut(c.Asset, ":")
			return code + " SAC"
		}
		return "SAC"
	case "external_ref":
		return "contract, shared executable"
	}
	return "contract"
}

// savedSession is a named session in the fork cache: its writes, and how
// many calls it has made, so a resumed session's seeds continue.
type savedSession struct {
	Calls   uint64                   `json:"calls"`
	Entries []simulator.AppliedEntry `json:"entries"`
}

// saveSession merges a call's writes into the session's saved writes, the
// latest write per key winning, and counts the call.
func saveSession(cache *fork.Cache, name string, saved savedSession, writes []simulator.ModifiedEntry) error {
	byKey := map[string]simulator.AppliedEntry{}
	var order []string
	for _, e := range saved.Entries {
		if _, seen := byKey[e.KeyXDR]; !seen {
			order = append(order, e.KeyXDR)
		}
		byKey[e.KeyXDR] = e
	}
	for _, w := range writes {
		if _, seen := byKey[w.KeyXDR]; !seen {
			order = append(order, w.KeyXDR)
		}
		byKey[w.KeyXDR] = simulator.AppliedEntry{KeyXDR: w.KeyXDR, EntryXDR: w.AfterXDR, LiveUntilLedger: w.LiveUntilLedger}
	}
	merged := make([]simulator.AppliedEntry, 0, len(order))
	for _, k := range order {
		merged = append(merged, byKey[k])
	}
	raw, err := json.Marshal(savedSession{Calls: saved.Calls + 1, Entries: merged})
	if err != nil {
		return err
	}
	return cache.PutMeta(sessionKey(name), raw)
}

// callError turns a simulator refusal of the call itself into the CLI's
// terms: an unknown function or a bad argument is the caller's mistake
// (exit 2), the rest stays a simulator failure.
func callError(ctx context.Context, sim *simulator.Client, req callRequest, err error) error {
	var se *simulator.Error
	if !errors.As(err, &se) {
		return err
	}
	if se.Code == "fetch_failed" && se.Detail["kind"] == "related" {
		other, _ := se.Detail["contract_id"].(string)
		return &inputError{fmt.Sprintf("--no-related: %s reached another contract, %s; drop --no-related to let it", req.function, other)}
	}
	if se.Code != "bad_request" {
		return err
	}
	path, _ := se.Detail["path"].(string)
	switch {
	case path == "function":
		names := contractFunctions(ctx, sim, req.contract)
		if len(names) == 0 {
			return &inputError{se.Message}
		}
		return &inputError{fmt.Sprintf("%s has no function %q; it has: %s", shorten(req.contract, 4, 3), req.function, strings.Join(names, ", "))}
	case strings.HasPrefix(path, "args"):
		return &inputError{se.Message}
	case path == "contract_id":
		return &inputError{se.Message}
	}
	return err
}

// contractFunctions lists a contract's functions from its spec.
func contractFunctions(ctx context.Context, sim *simulator.Client, contract string) []string {
	var spec simulator.SpecExtractResult
	if _, err := sim.Call(ctx, simulator.TypeSpecExtract, simulator.SpecExtractParams{Source: simulator.Source{ContractID: contract}}, &spec); err != nil {
		return nil
	}
	var doc struct {
		Functions []struct {
			Name string `json:"name"`
		} `json:"functions"`
	}
	if json.Unmarshal(spec.Spec, &doc) != nil {
		return nil
	}
	var names []string
	for _, f := range doc.Functions {
		if !strings.HasPrefix(f.Name, "__") {
			names = append(names, f.Name)
		}
	}
	sort.Strings(names)
	return names
}

// asInputError reports a bad_request about a flag's value as exit 2.
func asInputError(err error, flag string) error {
	var se *simulator.Error
	if errors.As(err, &se) && se.Code == "bad_request" {
		return &inputError{fmt.Sprintf("%s: %s", flag, se.Message)}
	}
	return err
}

// callView maps a call's result onto the three meanings (#556).
func callView(res CallResult) render.Call {
	c := render.Call{Function: res.Function, Value: string(res.ReturnValue), Writes: len(res.Modified)}
	for _, a := range res.Archived {
		c.Archived = append(c.Archived, render.Archived{Key: a.Key, LiveUntil: a.LiveUntilLedger, Restored: a.Outcome == "restored"})
	}
	if res.Outcome == "contract_error" {
		e := res.Error
		if e.Kind == "contract" {
			c.Kind = render.ContractError
			c.Error = &render.Refusal{Name: "contract error", Code: contractCode(e.Code)}
			if e.Decoded != nil && e.Decoded.ErrorName != "" {
				c.Error.Name, c.Error.Doc = e.Decoded.ErrorName, e.Decoded.ErrorDoc
				if e.Decoded.ErrorValue != nil {
					c.Error.Code = *e.Decoded.ErrorValue
				}
			}
			return c
		}
		c.Kind = render.HostError
		typ, code := hostParts(e.Code)
		c.Error = &render.Refusal{HostType: typ, HostCode: code}
		return c
	}
	for _, a := range res.AuthEntries {
		if a.Address != "" {
			c.Signers = append(c.Signers, render.Signer{Address: a.Address, Function: a.RootFunction.Function})
		}
	}
	readWrite := 0
	if res.Resources != nil {
		readWrite = len(res.Resources.Footprint.ReadWrite)
	}
	c.Kind = render.Classify(c.Writes, readWrite, c.Signers)
	return c
}

// hostParts reads "Error(Budget, ExceededLimit)".
func hostParts(code string) (string, string) {
	inner := strings.TrimSuffix(strings.TrimPrefix(code, "Error("), ")")
	typ, rest, ok := strings.Cut(inner, ", ")
	if !ok {
		return "Host", code
	}
	return typ, rest
}

// contractCode reads the n of "Error(Contract, #n)".
func contractCode(code string) int {
	_, rest, _ := strings.Cut(code, "#")
	n, _ := strconv.Atoi(strings.TrimSuffix(rest, ")"))
	return n
}

// callProvenance is the footer's facts.
func callProvenance(res CallResult) render.Provenance {
	p := render.Provenance{
		Network: res.Network, ForkLedger: res.ForkLedger, ForkTime: res.ForkTime,
		Protocol: res.Protocol, Drift: res.Drift.Count(), AuthMode: res.AuthMode,
	}
	if res.Session != "" {
		p.Overrides = append(p.Overrides, "session "+res.Session)
	}
	if res.SwappedWasm != "" {
		p.Overrides = append(p.Overrides, "wasm "+shorten(res.SwappedWasm, 4, 2)+" swapped in")
	}
	if n := len(res.StorageOverrides); n > 0 {
		noun := "overrides"
		if n == 1 {
			noun = "override"
		}
		p.Overrides = append(p.Overrides, fmt.Sprintf("%d %s", n, noun))
	}
	if l := res.Ledger; l != nil && l.Overridden {
		if l.Sequence != res.ForkLedger {
			p.Overrides = append(p.Overrides, fmt.Sprintf("ledger %d (%+d)", l.Sequence, int64(l.Sequence)-int64(res.ForkLedger)))
		}
		at := time.Unix(int64(l.Timestamp), 0).UTC()
		if !at.Equal(res.ForkTime) {
			p.Overrides = append(p.Overrides, fmt.Sprintf("time %s (%s)", at.Format(time.RFC3339), span(at.Sub(res.ForkTime))))
		}
	}
	if b := res.Budget; b != nil {
		if res.Unlimited {
			p.Overrides = append(p.Overrides, fmt.Sprintf("budget unlimited (%d instructions, 10x)", b.Instructions))
		} else {
			p.Overrides = append(p.Overrides, fmt.Sprintf("budget %d instructions", b.Instructions))
		}
	}
	return p
}

// span is a time offset as +30d, +12h, -90m.
func span(d time.Duration) string {
	sign := "+"
	if d < 0 {
		sign, d = "-", -d
	}
	day := 24 * time.Hour
	switch {
	case d%day == 0:
		return fmt.Sprintf("%s%dd", sign, d/day)
	case d >= day:
		return fmt.Sprintf("%s%dd%s", sign, d/day, (d % day).String())
	}
	return sign + d.String()
}

// renderedFailure gives a simulator failure or a timeout its own wording and
// the provenance footer, keeping the error (and so the exit code) intact.
func renderedFailure(err error, res CallResult, deps Deps) error {
	var te *simulator.TimeoutError
	var se *simulator.Error
	kind := render.SimulatorError
	switch {
	case errors.As(err, &te):
		kind = render.Timeout
	case errors.As(err, &se):
	default:
		return err
	}
	var buf strings.Builder
	_ = render.Render(&buf, render.Call{Kind: kind, Function: res.Function, Failure: failureText(err)},
		callProvenance(res), now(deps), render.Style{})
	return &renderedError{err: err, text: strings.TrimRight(buf.String(), "\n")}
}

func failureText(err error) string {
	var te *simulator.TimeoutError
	if errors.As(err, &te) {
		return fmt.Sprintf("%s did not answer within %s", te.Type, te.Timeout)
	}
	var se *simulator.Error
	if errors.As(err, &se) {
		return strings.TrimPrefix(se.Error(), "simulator error: ")
	}
	return err.Error()
}

// renderedError prints as its rendering and unwraps to the cause.
type renderedError struct {
	err  error
	text string
}

func (e *renderedError) Error() string { return e.text }
func (e *renderedError) Unwrap() error { return e.err }

func newSandboxSessionCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "session",
		Short: "Manage named call sessions",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return cmd.Help()
		},
	}
	reset := &cobra.Command{
		Use:   "reset <name>",
		Short: "Forget a session's writes, on every fork",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			root, err := forkRoot(deps)
			if err != nil {
				return err
			}
			forks, err := fork.List(root)
			if err != nil {
				return fmt.Errorf("%w: reading the fork cache: %v", exitcode.ErrConfiguration, err)
			}
			cleared := []string{}
			for _, f := range forks {
				c, err := fork.Open(root, f.Passphrase, f.ID)
				if err != nil {
					return err
				}
				had, _ := c.Meta(sessionKey(args[0]))
				if had != nil {
					if err := c.DeleteMeta(sessionKey(args[0])); err != nil {
						_ = c.Close()
						return err
					}
					cleared = append(cleared, f.ID)
				}
				_ = c.Close()
			}
			res := struct {
				Session string   `json:"session"`
				Forks   []string `json:"forks"`
			}{args[0], cleared}
			return printerFor(cmd).Result(res, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "Reset session %s on %d fork(s).\n", args[0], len(cleared))
				return err
			})
		},
	}
	cmd.AddCommand(reset)
	return cmd
}
