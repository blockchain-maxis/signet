package cmd

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/dev"
	"github.com/blockchain-maxis/signet/cli/internal/devconfig"
	"github.com/blockchain-maxis/signet/cli/internal/devui"
	"github.com/blockchain-maxis/signet/cli/internal/rpc"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// uiSession is the UI's view of signet dev's session (#577): the same
// fork, reloader and cycles the terminal shows. Every use of the simulator
// takes the session's lock, so a UI request never lands in the middle of a
// reload cycle.
type uiSession struct {
	deps    Deps
	network rpc.Network
	session *devSession
	builder *dev.Builder
	setup   *devSetup

	mu     sync.Mutex
	nextID int
	added  []devui.Override // overrides added from the UI, on top of the file's
}

var _ devui.Session = (*uiSession)(nil)

func (u *uiSession) Info() any {
	m := u.session.manifest
	file := ""
	calls, overrides := 0, 0
	if u.setup.file != nil {
		file = filepath.Join(u.setup.fileDir, devconfig.FileName)
		calls, overrides = len(u.setup.file.Calls), len(u.setup.file.Overrides)
	}
	return map[string]any{
		"contract": m.Contract,
		"network":  map[string]any{"name": m.Network, "passphrase": m.Passphrase},
		"fork": map[string]any{
			"id": u.session.forkID, "ledger": m.ForkLedger, "time": m.ForkTime.UTC().Format(time.RFC3339),
			"consistent": m.Consistent, "drifted_entries": m.DriftedEntries,
		},
		"lane":   m.Protocol,
		"crate":  map[string]any{"name": u.setup.crate.Name, "manifest": u.setup.crate.ManifestPath},
		"build":  u.builder.Last(),
		"config": map[string]any{"file": file, "calls": calls, "overrides": overrides, "ui_overrides": len(u.added)},
	}
}

func (u *uiSession) localWasm() ([]byte, error) {
	if u.builder.Last() == "" {
		return nil, &devui.InputError{Msg: "there is no build yet"}
	}
	return os.ReadFile(u.builder.Last())
}

func (u *uiSession) Spec(ctx context.Context, which string) (json.RawMessage, error) {
	source := simulator.Source{ContractID: u.session.manifest.Contract}
	if which == "local" {
		wasm, err := u.localWasm()
		if err != nil {
			return nil, err
		}
		source = simulator.Source{WasmBase64: base64.StdEncoding.EncodeToString(wasm)}
	}
	u.session.mu.Lock()
	defer u.session.mu.Unlock()
	var out simulator.SpecExtractResult
	if _, err := callSimulator(ctx, u.session.sim, simulator.TypeSpecExtract, simulator.SpecExtractParams{Source: source}, &out); err != nil {
		return nil, err
	}
	return out.Spec, nil
}

func sha(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func (u *uiSession) Wasm(hash string) ([]byte, bool) {
	if deployed := u.session.reloader.DeployedWasm(); sha(deployed) == hash {
		return deployed, true
	}
	if local, err := u.localWasm(); err == nil && sha(local) == hash {
		return local, true
	}
	return nil, false
}

// Call runs the call as signet sandbox call does: its own simulator, the
// same fork, the same limits.
func (u *uiSession) Call(ctx context.Context, r devui.CallRequest) (any, error) {
	req := callRequest{
		contract: u.session.manifest.Contract, function: r.Function, args: r.Args,
		sourceAccount: r.SourceAccount, authMode: r.AuthMode,
	}
	if req.args == nil {
		req.args = map[string]any{}
	}
	if req.authMode == "" {
		req.authMode = "record"
	}
	if r.Ledger != nil {
		req.move.sequence = r.Ledger.Sequence
		if r.Ledger.Timestamp != nil {
			at := time.Unix(int64(*r.Ledger.Timestamp), 0).UTC()
			req.move.timestamp = &at
		}
	}
	for _, o := range r.Overrides {
		req.overrides = append(req.overrides, storageOverride{durability: o.Durability, key: o.Key, value: o.Value, unset: o.Unset, source: o.Key})
	}
	switch r.Wasm {
	case "", "deployed":
	case "local":
		wasm, err := u.localWasm()
		if err != nil {
			return nil, err
		}
		req.wasm = wasm
	default:
		return nil, &devui.InputError{Msg: "wasm must be deployed or local"}
	}
	res, _, err := runCall(ctx, u.deps, u.network, req, func(string) {})
	if err != nil {
		var input *inputError
		if asInput(err, &input) {
			return nil, &devui.InputError{Msg: input.Error()}
		}
		return nil, err
	}
	return res, nil
}

func asInput(err error, target **inputError) bool {
	e, ok := err.(*inputError)
	if ok {
		*target = e
	}
	return ok
}

func (u *uiSession) Cycle(id string) (any, bool) {
	return u.session.cycle(id)
}

func (u *uiSession) State(ctx context.Context, layer string) (any, error) {
	switch layer {
	case "override":
		u.mu.Lock()
		defer u.mu.Unlock()
		var out []devui.Override
		for i, o := range fileOverrides(u.setup.file) {
			out = append(out, devui.Override{ID: fmt.Sprintf("file-%d", i+1), Durability: o.Durability, Key: o.Key, Value: o.Value, Unset: o.Unset})
		}
		out = append(out, u.added...)
		if out == nil {
			out = []devui.Override{}
		}
		return map[string]any{"layer": layer, "overrides": out}, nil
	case "session":
		return map[string]any{"layer": layer, "entries": []any{},
			"note": "the session is rolled back to base between cycles, so it holds no writes of its own"}, nil
	}
	entries, err := u.session.cache.Entries()
	if err != nil {
		return nil, err
	}
	describe := make([]simulator.DescribeEntry, len(entries))
	for i, e := range entries {
		describe[i] = simulator.DescribeEntry{DataXDR: e.XDR, LastModifiedLedgerSeq: e.LastModifiedLedgerSeq, ExtXDR: e.ExtXDR}
	}
	u.session.mu.Lock()
	var described simulator.EntriesDescribeResult
	_, err = callSimulator(ctx, u.session.sim, simulator.TypeEntriesDescribe, simulator.EntriesDescribeParams{Entries: describe}, &described)
	u.session.mu.Unlock()
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, len(entries))
	for i, e := range entries {
		out[i] = map[string]any{
			"key": e.Key, "xdr": e.XDR, "last_modified_ledger_seq": e.LastModifiedLedgerSeq, "live_until_ledger_seq": e.LiveUntilLedgerSeq,
			"provenance": map[string]any{"fetched_at_ledger": e.FetchedAtLedger, "drifted": e.Drifted},
		}
		if i < len(described.Entries) {
			out[i]["decoded"] = described.Entries[i]
		}
	}
	return map[string]any{"layer": layer, "entries": out}, nil
}

// overrides are the file's and the UI's, as the session applies them.
func (u *uiSession) overrides() []devconfig.Override {
	out := append([]devconfig.Override{}, fileOverrides(u.setup.file)...)
	for _, o := range u.added {
		out = append(out, devconfig.Override{Durability: o.Durability, Key: o.Key, Value: o.Value, Unset: o.Unset})
	}
	return out
}

func (u *uiSession) apply(ctx context.Context) error {
	u.session.mu.Lock()
	defer u.session.mu.Unlock()
	return u.session.reset(ctx, u.overrides())
}

func (u *uiSession) AddOverride(ctx context.Context, o devui.Override) (string, error) {
	switch o.Durability {
	case "instance", "persistent", "temporary":
	default:
		return "", &devui.InputError{Msg: "durability must be instance, persistent or temporary"}
	}
	if o.Key == "" || o.Unset == (o.Value != "") {
		return "", &devui.InputError{Msg: "an override needs a key, and a value or unset: true"}
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	u.nextID++
	o.ID = "ui-" + strconv.Itoa(u.nextID)
	u.added = append(u.added, o)
	if err := u.apply(ctx); err != nil {
		u.added = u.added[:len(u.added)-1]
		var input *inputError
		if asInput(err, &input) {
			return "", &devui.InputError{Msg: input.Error()}
		}
		return "", err
	}
	return o.ID, nil
}

func (u *uiSession) DeleteOverride(ctx context.Context, id string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	for i, o := range u.added {
		if o.ID == id {
			u.added = append(u.added[:i], u.added[i+1:]...)
			return u.apply(ctx)
		}
	}
	return devui.ErrNotFound
}

// SaveCall appends to signet.dev.toml exactly as sandbox call --save does
// (#561): append only, comments and all kept.
func (u *uiSession) SaveCall(_ context.Context, c devui.SavedCall) error {
	if u.setup.file == nil {
		return &devui.InputError{Msg: "there is no signet.dev.toml to save to: signet dev init writes one"}
	}
	call := devconfig.Call{Name: c.Name, Function: c.Function, Args: c.Args}
	if call.Name == "" {
		call.Name = c.Function
	}
	expect := c.Expect
	if expect == "" {
		expect = "unchanged"
	}
	if err := call.Expect.UnmarshalText([]byte(expect)); err != nil {
		return &devui.InputError{Msg: err.Error()}
	}
	path := filepath.Join(u.setup.fileDir, devconfig.FileName)
	if err := devconfig.AppendCall(path, call); err != nil {
		return &devui.InputError{Msg: err.Error()}
	}
	return nil
}
