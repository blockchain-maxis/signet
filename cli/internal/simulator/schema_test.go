package simulator

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/jsonschema"
)

// The Go structs are hand-written, so this test is what keeps them honest:
// every request and result is marshalled the way Client sends or receives it
// and validated against sandbox/protocol/schema/v1.

func schemaDir() string {
	return filepath.Join("..", "..", "..", "sandbox", "protocol", "schema", "v1")
}

func loadSchema(t *testing.T, typ string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(schemaDir(), typ+".json"))
	if err != nil {
		t.Fatalf("read schema %s: %v", typ, err)
	}
	var s map[string]any
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("parse schema %s: %v", typ, err)
	}
	return s
}

// message builds a whole line the way Client would put it on the pipe.
func message(t *testing.T, typ string, body any) any {
	t.Helper()
	fields, err := toFields(body)
	if err != nil {
		t.Fatalf("%s: %v", typ, err)
	}
	b, err := envelopeBytes("req-1", typ, fields)
	if err != nil {
		t.Fatal(err)
	}
	var v any
	_ = json.Unmarshal(b, &v)
	return v
}

func u32(v uint32) *uint32  { return &v }
func sp(s string) *string   { return &s }
func ip(v int) *int         { return &v }
func fp(v float64) *float64 { return &v }

func TestMessagesMatchTheSchemas(t *testing.T) {
	b64 := "AAAAAwAAAAE="
	hash := strings.Repeat("ab", 32)
	src := Source{WasmBase64: "AGFzbQEAAAA="}
	sim := SimulateResult{ReturnValueXDR: b64, Events: []Event{{Type: "contract", EventXDR: b64}}, Cost: Cost{CPUInsns: 1, MemBytes: 2}, Logs: []string{"hi"}}
	full := sim
	full.ReturnValue = json.RawMessage(`{"a":1}`)
	full.Events = []Event{{Type: "contract", EventXDR: b64, Decoded: json.RawMessage(`{"name":"transfer"}`)}}
	full.DiagnosticEvents, full.Auth, full.Misses = []string{b64}, []string{b64}, []string{b64}
	full.ModifiedEntries = []ModifiedEntry{{KeyXDR: b64, BeforeXDR: nil, AfterXDR: sp(b64), LiveUntilLedger: u32(7)}}
	full.Resources = &Resources{Instructions: 1, DiskReadBytes: 2, WriteBytes: 3, Footprint: Footprint{ReadOnly: []string{b64}, ReadWrite: []string{}}}
	full.Fee = &Fee{ResourceFee: 100}
	full.Ledger = &LedgerInfo{Sequence: 5, Timestamp: 6, Protocol: 28}
	full.Seed = hash
	full.Budget = &Budget{Instructions: 1, MemBytes: 2}

	requests := map[string]any{
		TypeLedgerOpen:       LedgerOpenParams{NetworkPassphrase: "Test SDF Network ; September 2015", LedgerProtocol: ip(28), Sequence: u32(5), Fetch: "deny", BaseReserve: u32(5000000), Entries: []PutEntry{{KeyXDR: b64, DataXDR: b64, LastModifiedLedgerSeq: u32(1)}}},
		TypeLedgerPut:        LedgerPutParams{Entries: []PutEntry{{KeyXDR: b64, EntryXDR: b64, LiveUntilLedger: u32(9)}}},
		TypeLedgerGet:        LedgerGetParams{KeysXDR: []string{b64}},
		TypeLedgerCheckpoint: LedgerCheckpointParams{Label: "x"},
		TypeLedgerRollback:   LedgerRollbackParams{Checkpoint: "cp-1"},
		TypeLedgerApply:      LedgerApplyParams{Entries: []AppliedEntry{{KeyXDR: b64, EntryXDR: sp(b64), LiveUntilLedger: u32(9)}, {KeyXDR: b64}}},
		TypeLedgerImport:     LedgerImportParams{LedgerSequence: 7, Entries: []PutEntry{{KeyXDR: b64, EntryXDR: b64}, {KeyXDR: b64, DataXDR: b64, LastModifiedLedgerSeq: u32(4), ExtXDR: "AAAAAA=="}}},
		TypeContractInstall:  ContractInstallParams{WasmBase64: "AGFzbQEAAAA=", ContractID: registry},
		TypeContractSwap:     ContractSwapParams{ContractID: registry, WasmHash: hash, Layer: "session", Mode: "ref"},
		TypeContractInfo:     ContractInfoParams{ContractID: registry},
		TypeSimulate:         SimulateParams{ContractID: registry, Function: "f", Args: map[string]any{"a": 1, "b": []any{"x"}}, SourceAccount: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", Diagnostics: true, DryRun: true, Budget: &Budget{Instructions: 5}},
		TypeSpecExtract:      SpecExtractParams{Source: Source{ContractID: registry}},
		TypeSpecEncodeArgs:   SpecEncodeArgsParams{Source: src, Function: "f", Args: map[string]any{"handle": "a"}},
		TypeSpecDecodeVal:    SpecDecodeValParams{Source: src, Function: "f", ValXDR: b64},
		TypeSpecDiff:         SpecDiffParams{Old: src, New: Source{ContractID: registry}},
		TypeLayoutCheck:      LayoutCheckParams{Old: src, New: src},
		TypeDiffResults:      DiffResultsParams{LedgerProtocol: ip(28), A: DiffSideOf(&full, nil), B: DiffSideOf(nil, &ContractError{Kind: "contract", Code: "Error(Contract, #1)"})},
		TypeXDRKeys: XDRKeysParams{LedgerProtocol: ip(28), Keys: []XDRKey{
			{Kind: "contract_instance", ContractID: registry},
			{Kind: "contract_code", WasmHash: hash},
			{Kind: "account", AccountID: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"},
			{Kind: "config_setting", Setting: "contract_max_size_bytes"},
			{Kind: "network_config"},
		}},
		TypeTxDecode:    TxDecodeParams{TransactionXDR: b64, ResultMetaXDR: b64},
		TypeWasmInspect: WasmInspectParams{WasmBase64: "AGFzbQEAAAA="},
		TypeStatus:      nil,
		TypeShutdown:    nil,
	}
	results := map[string]any{
		TypeLedgerOpen:       LedgerOpenResult{LedgerProtocol: 28, Sequence: 1, NetworkConfig: json.RawMessage(`{"min_persistent_ttl":4096}`)},
		TypeLedgerPut:        LedgerPutResult{Written: 1},
		TypeLedgerGet:        LedgerGetResult{Entries: []GotEntry{{KeyXDR: b64, EntryXDR: sp(b64), Provenance: &Provenance{Source: "fork", FetchedAtLedger: u32(3), LastModifiedLedgerSeq: 2}}, {KeyXDR: b64}}},
		TypeLedgerCheckpoint: LedgerCheckpointResult{Checkpoint: "cp-1"},
		TypeLedgerRollback:   nil,
		TypeLedgerApply:      LedgerApplyResult{Applied: 2},
		TypeLedgerImport:     LedgerImportResult{Imported: 1, LedgerSequence: 7},
		TypeContractInstall:  ContractInstallResult{ContractID: registry, WasmHash: hash},
		TypeContractSwap:     ContractSwapResult{ContractID: registry, PreviousWasmHash: sp(hash), WasmHash: hash, Mode: "instance", Layer: "session"},
		TypeContractInfo:     ContractInfoResult{ContractID: registry, Executable: "wasm", WasmHash: sp(hash), StorageEntries: 3, InstanceLiveUntil: u32(9), WasmSize: 6240, Misses: []string{b64}},
		TypeSimulate:         full,
		TypeSpecExtract:      SpecExtractResult{SpecEntriesXDR: []string{b64}, WasmHash: hash, Spec: json.RawMessage(`{"schemaVersion":1,"wasmHash":"` + hash + `","entriesXdr":["` + b64 + `"]}`)},
		TypeSpecEncodeArgs:   SpecEncodeArgsResult{ArgsXDR: []string{b64}},
		TypeSpecDecodeVal:    SpecDecodeValResult{Value: json.RawMessage(`{"a":1}`)},
		TypeSpecDiff:         SpecDiffResult{Compatible: true, Changes: []json.RawMessage{}},
		TypeLayoutCheck:      LayoutCheckResult{Compatible: true, Issues: []json.RawMessage{}},
		TypeDiffResults: DiffResultsResult{
			Outcome:     &DiffOutcome{A: "ok", B: "contract error Error(Contract, #1)"},
			ReturnValue: &Difference{Path: "/0", A: json.RawMessage(`{"type":"u32","value":1}`), B: json.RawMessage(`null`)},
			Events:      DiffEvents{Added: []EventChange{{Index: 0, Event: json.RawMessage(`{}`)}}, Removed: []EventChange{}, Changed: []EventChange{{Index: 1, Topics: []json.RawMessage{json.RawMessage(`{}`)}, Path: sp("/data"), A: json.RawMessage(`1`), B: json.RawMessage(`2`)}}},
			Storage:     DiffStorage{Added: []StorageChange{{Key: "C… persistent data \"last\"", KeyXDR: b64, Entry: json.RawMessage(`{}`)}}, Removed: []StorageChange{}, Changed: []StorageChange{{Key: "k", KeyXDR: b64, Path: sp(""), A: json.RawMessage(`null`), B: json.RawMessage(`{}`)}}, TTL: []StorageChange{}},
			Auth:        DiffAuth{ClientBreaking: true, Added: []AuthChange{{Signer: "G…", Invocation: json.RawMessage(`{}`)}}, Removed: []AuthChange{}, Changed: []AuthChange{}},
			Resources:   []ResourceChange{{Metric: "instructions", A: 1000, B: 1250, Delta: 250, Percent: fp(25)}, {Metric: "write_bytes", A: 0, B: 8, Delta: 8}},
		},
		TypeXDRKeys:     XDRKeysResult{Keys: []BuiltKey{{Kind: "account", Subject: "G…", KeyXDR: b64}}},
		TypeTxDecode:    nil, // the transaction body is passed through as JSON
		TypeWasmInspect: WasmInspectResult{WasmHash: hash, SizeBytes: 8, CustomSections: []string{"contractspecv0"}, InterfaceVersion: &InterfaceVersion{Protocol: 22}, Exports: []string{"f"}, Imports: []WasmImport{{Module: "x", Name: "_"}}, Upgradeable: "none"},
		TypeStatus:      StatusResult{UptimeMS: 5, LedgerOpen: true, LedgerSequence: u32(1), Entries: 1, Contracts: 1, NetworkConfig: json.RawMessage(`{}`), BaseReserve: u32(5000000)},
		TypeShutdown:    nil,
	}

	for typ, body := range requests {
		t.Run(typ, func(t *testing.T) {
			schema := loadSchema(t, typ)
			if errs := jsonschema.Validate(schema, schema, message(t, typ, body)); len(errs) > 0 {
				t.Errorf("request does not match the schema:\n  %s", strings.Join(errs, "\n  "))
			}
			res, ok := results[typ]
			if !ok || (res == nil && typ == TypeTxDecode) {
				return
			}
			rs := schema["definitions"].(map[string]any)["result"]
			msg := message(t, TypeResult, res)
			if errs := jsonschema.Validate(schema, rs, msg); len(errs) > 0 {
				t.Errorf("result does not match definitions.result:\n  %s", strings.Join(errs, "\n  "))
			}
		})
	}

	// The messages that are not request/response pairs.
	others := map[string]any{
		TypeHello:         Hello{ClientProtocolVersion: ProtocolVersion},
		TypeHelloAck:      HelloAck{ServerProtocolVersion: 1, SimulatorVersion: "0.1.0", Commit: "abc", Lanes: []Lane{{LedgerProtocol: 28, EnvHost: "28.0.2", Simulation: "28.0.2"}}},
		TypeContractError: ContractError{Kind: "contract", Code: "Error(Contract, #2)", Message: "m", Seed: strings.Repeat("0", 64), Decoded: &DecodedError{ErrorEnum: "Error", ErrorName: "X", ErrorValue: ip(2), Candidates: []ErrorCandidate{{ErrorEnum: "A", ErrorName: "X"}}}, DiagnosticEvents: []string{b64}, Cost: &Cost{CPUInsns: 1}, Misses: []string{b64}, Ledger: &LedgerInfo{Sequence: 1, Protocol: 28}},
		TypeError:         ErrorMessage{Code: "bad_request", Message: "m", Detail: map[string]any{"kind": "invalid_json"}},
		TypeLedgerFetch:   LedgerFetch{KeysXDR: []string{b64}},
		TypeLedgerEntries: LedgerEntries{Entries: []Entry{{KeyXDR: b64, EntryXDR: sp(b64), LiveUntilLedger: u32(1)}, {KeyXDR: b64}, {KeyXDR: b64, DataXDR: b64, LastModifiedLedgerSeq: u32(9), ExtXDR: "AAAAAA==", LiveUntilLedger: u32(99)}}},
	}
	for typ, body := range others {
		t.Run(typ, func(t *testing.T) {
			schema := loadSchema(t, typ)
			msg := message(t, typ, body).(map[string]any)
			if typ == TypeLedgerFetch || typ == TypeLedgerEntries {
				msg["id"] = "sim-1"
			}
			if errs := jsonschema.Validate(schema, schema, msg); len(errs) > 0 {
				t.Errorf("does not match the schema:\n  %s", strings.Join(errs, "\n  "))
			}
		})
	}
}

// Go's answer to a ledger_fetch it could not serve is an `error` line, and it
// has to be one the schema accepts.
func TestFetchRepliesMatchTheSchemas(t *testing.T) {
	for name, err := range map[string]error{"ok": nil, "failed": fmt.Errorf("boom")} {
		t.Run(name, func(t *testing.T) {
			b, _ := fetchReply("sim-3", nil, err)
			var msg any
			_ = json.Unmarshal(b, &msg)
			typ := TypeLedgerEntries
			if err != nil {
				typ = TypeError
			}
			schema := loadSchema(t, typ)
			if errs := jsonschema.Validate(schema, schema, msg); len(errs) > 0 {
				t.Errorf("%s reply does not match:\n  %s", typ, strings.Join(errs, "\n  "))
			}
		})
	}
}

func TestEveryRequestSchemaHasAGoStruct(t *testing.T) {
	entries, err := os.ReadDir(schemaDir())
	if err != nil {
		t.Fatal(err)
	}
	known := map[string]bool{}
	for _, typ := range []string{
		TypeHello, TypeHelloAck, TypeError, TypeContractError, TypeLedgerFetch, TypeLedgerEntries,
		TypeLedgerOpen, TypeLedgerPut, TypeLedgerGet, TypeLedgerCheckpoint, TypeLedgerRollback,
		TypeLedgerImport, TypeLedgerApply, TypeContractInstall, TypeContractSwap, TypeContractInfo, TypeSimulate, TypeSpecExtract,
		TypeSpecEncodeArgs, TypeSpecDecodeVal, TypeSpecDiff, TypeLayoutCheck, TypeDiffResults,
		TypeXDRKeys, TypeTxDecode, TypeWasmInspect, TypeStatus, TypeShutdown,
		TypeSnapshotRead, TypeEntriesDescribe, TypeStorageOverride,
	} {
		known[typ] = true
	}
	known["trace"] = true           // a document inside results: the Trace struct
	known["signet-dev-toml"] = true // signet.dev.toml's schema: internal/devconfig
	var missing []string
	for _, e := range entries {
		typ := strings.TrimSuffix(e.Name(), ".json")
		if strings.HasPrefix(typ, "cli-") {
			continue // CLI output, not a wire message
		}
		if !known[typ] {
			missing = append(missing, typ)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Fatalf("schemas with no Type constant or struct in messages.go: %v", missing)
	}
}

func TestTraceRoundTripsTheTranscript(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "sandbox", "protocol", "transcripts", "trace.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.Contains(line, `"trace":{`) {
			continue
		}
		var res SimulateResult
		if err := json.Unmarshal([]byte(line), &res); err != nil {
			t.Fatal(err)
		}
		var whole struct {
			Trace map[string]any `json:"trace"`
		}
		_ = json.Unmarshal([]byte(line), &whole)
		back, _ := json.Marshal(res.Trace)
		var got map[string]any
		_ = json.Unmarshal(back, &got)
		if !reflect.DeepEqual(got, whole.Trace) {
			t.Fatalf("Trace drops or changes fields:\n got %v\nwant %v", got, whole.Trace)
		}
		if len(res.Trace.Frames) != 2 || res.Trace.Frames[1].Parent == nil || *res.Trace.Frames[1].Parent != 0 {
			t.Fatalf("frames = %+v", res.Trace.Frames)
		}
		return
	}
	t.Fatal("no traced result in trace.ndjson")
}
