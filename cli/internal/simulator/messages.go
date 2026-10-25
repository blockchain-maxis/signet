package simulator

import "encoding/json"

// ProtocolVersion is the wire protocol this CLI speaks
// (docs/CLI_RUST_BRIDGE.md §2). It must equal the spawned binary's
// server_protocol_version exactly.
const ProtocolVersion = 1

// Message types, one per sandbox/protocol/schema/v1/<type>.json.
const (
	TypeHello            = "hello"
	TypeHelloAck         = "hello_ack"
	TypeResult           = "result"
	TypeError            = "error"
	TypeContractError    = "contract_error"
	TypeLedgerFetch      = "ledger_fetch"
	TypeLedgerEntries    = "ledger_entries"
	TypeLedgerOpen       = "ledger_open"
	TypeLedgerPut        = "ledger_put"
	TypeLedgerGet        = "ledger_get"
	TypeLedgerCheckpoint = "ledger_checkpoint"
	TypeLedgerRollback   = "ledger_rollback"
	TypeLedgerImport     = "ledger_import"
	TypeLedgerApply      = "ledger_apply"
	TypeContractInstall  = "contract_install"
	TypeContractSwap     = "contract_swap"
	TypeContractInfo     = "contract_info"
	TypeSimulate         = "simulate"
	TypeSpecExtract      = "spec_extract"
	TypeSpecEncodeArgs   = "spec_encode_args"
	TypeSpecDecodeVal    = "spec_decode_val"
	TypeSpecDiff         = "spec_diff"
	TypeLayoutCheck      = "layout_check"
	TypeDiffResults      = "diff_results"
	TypeXDRKeys          = "xdr_keys"
	TypeTxDecode         = "tx_decode"
	TypeWasmInspect      = "wasm_inspect"
	TypeSnapshotRead     = "snapshot_read"
	TypeEntriesDescribe  = "entries_describe"
	TypeStorageOverride  = "storage_override"
	TypeStatus           = "status"
	TypeShutdown         = "shutdown"
)

// envelope is the part of every message both directions share. Raw keeps the
// whole line so the type-specific body can be decoded once the type is known.
type envelope struct {
	Version int             `json:"version"`
	ID      *string         `json:"id"`
	Type    string          `json:"type"`
	Raw     json.RawMessage `json:"-"`
}

// Hello is the first line Go writes on every process.
type Hello struct {
	ClientProtocolVersion int `json:"client_protocol_version"`
}

// HelloAck is the simulator's answer to Hello.
type HelloAck struct {
	ServerProtocolVersion int    `json:"server_protocol_version"`
	SimulatorVersion      string `json:"simulator_version"`
	Commit                string `json:"commit"`
	Lanes                 []Lane `json:"lanes"`
}

// Lane is one ledger protocol the binary can run.
type Lane struct {
	LedgerProtocol int    `json:"ledger_protocol"`
	EnvHost        string `json:"env_host"`
	Simulation     string `json:"simulation"`
}

// ErrorMessage is an `error` line: a protocol-level failure, never an answer
// about the contract under test (§3).
type ErrorMessage struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Detail  map[string]any `json:"detail"`
}

// ContractError is a `contract_error` line: the call ran, and the contract or
// the host said no. Call returns it as a value, never as a Go error.
type ContractError struct {
	Kind             string            `json:"kind"` // "contract" or "host"
	Code             string            `json:"code"`
	Message          string            `json:"message"`
	Decoded          *DecodedError     `json:"decoded,omitempty"`
	DiagnosticEvents []string          `json:"diagnostic_events"`
	Cost             *Cost             `json:"cost,omitempty"`
	Misses           []string          `json:"misses,omitempty"`
	Ledger           *LedgerInfo       `json:"ledger,omitempty"`
	Seed             string            `json:"seed,omitempty"`
	Budget           *Budget           `json:"budget,omitempty"`
	AuthMode         string            `json:"auth_mode,omitempty"`
	Archived         []Archived        `json:"archived,omitempty"`
	Trace            *Trace            `json:"trace,omitempty"`
	Contracts        []RelatedContract `json:"contracts,omitempty"`
}

// DecodedError is a contracterror read from the contract's spec (#546).
type DecodedError struct {
	ErrorEnum  string `json:"error_enum,omitempty"`
	ErrorName  string `json:"error_name,omitempty"`
	ErrorValue *int   `json:"error_value,omitempty"`
	ErrorDoc   string `json:"error_doc,omitempty"`
	// Candidates lists every error-enum case at this code when more than
	// one contracterror enum has one.
	Candidates []ErrorCandidate `json:"candidates,omitempty"`
}

// ErrorCandidate is one error-enum case a contract error code may be.
type ErrorCandidate struct {
	ErrorEnum string `json:"error_enum"`
	ErrorName string `json:"error_name"`
	ErrorDoc  string `json:"error_doc,omitempty"`
}

// LedgerInfo is the ledger a call ran against.
type LedgerInfo struct {
	Sequence  uint32 `json:"sequence"`
	Timestamp uint64 `json:"timestamp"`
	Protocol  int    `json:"protocol"`
	// Overridden is set when the call ran at another ledger than the
	// session's (#558).
	Overridden bool `json:"overridden,omitempty"`
}

// Archived is an archived entry a call read (#558). A persistent one is
// restored by the call, as the network does from protocol 23 ("restored");
// an expired temporary one read as absent ("expired").
type Archived struct {
	KeyXDR          string `json:"key_xdr"`
	Key             string `json:"key"`
	LiveUntilLedger uint32 `json:"live_until_ledger"`
	Outcome         string `json:"outcome"`
}

// LedgerFetch is the simulator asking Go for entries mid-call (#531).
type LedgerFetch struct {
	KeysXDR []string `json:"keys_xdr"`
}

// Entry is one ledger entry crossing the pipe, as Go answers a
// ledger_fetch. Either EntryXDR is a whole LedgerEntry (nil: the key does
// not exist), or DataXDR, LastModifiedLedgerSeq and ExtXDR carry the pieces
// RPC's getLedgerEntries returns and the simulator assembles the entry, so Go
// never builds XDR.
type Entry struct {
	KeyXDR                string  `json:"key_xdr"`
	EntryXDR              *string `json:"entry_xdr,omitempty"`
	DataXDR               string  `json:"data_xdr,omitempty"`
	LastModifiedLedgerSeq *uint32 `json:"last_modified_ledger_seq,omitempty"`
	ExtXDR                string  `json:"ext_xdr,omitempty"`
	LiveUntilLedger       *uint32 `json:"live_until_ledger,omitempty"`
}

// Absent is the Entry for a key the network does not have.
func Absent(keyXDR string) Entry { return Entry{KeyXDR: keyXDR} }

// MarshalJSON keeps `entry_xdr: null` for an absent key, which omitempty
// would otherwise drop.
func (e Entry) MarshalJSON() ([]byte, error) {
	if e.EntryXDR == nil && e.DataXDR == "" {
		return json.Marshal(struct {
			KeyXDR          string  `json:"key_xdr"`
			EntryXDR        *string `json:"entry_xdr"`
			LiveUntilLedger *uint32 `json:"live_until_ledger,omitempty"`
		}{e.KeyXDR, nil, e.LiveUntilLedger})
	}
	type plain Entry
	return json.Marshal(plain(e))
}

// LedgerEntries is Go's answer to a LedgerFetch.
type LedgerEntries struct {
	Entries []Entry `json:"entries"`
}

// PutEntry is an entry written with ledger_put or ledger_import: EntryXDR,
// or RPC's pieces (DataXDR, LastModifiedLedgerSeq, ExtXDR) instead.
type PutEntry struct {
	KeyXDR                string  `json:"key_xdr"`
	EntryXDR              string  `json:"entry_xdr,omitempty"`
	DataXDR               string  `json:"data_xdr,omitempty"`
	LastModifiedLedgerSeq *uint32 `json:"last_modified_ledger_seq,omitempty"`
	ExtXDR                string  `json:"ext_xdr,omitempty"`
	LiveUntilLedger       *uint32 `json:"live_until_ledger,omitempty"`
}

// LedgerOpenParams opens or resets the session's ledger.
type LedgerOpenParams struct {
	NetworkPassphrase string  `json:"network_passphrase"`
	LedgerProtocol    *int    `json:"ledger_protocol,omitempty"`
	Sequence          *uint32 `json:"sequence,omitempty"`
	Timestamp         *uint64 `json:"timestamp,omitempty"`
	// Fetch is "allow" (the default: misses become ledger_fetch) or "deny"
	// (a miss is a fetch_failed error; offline runs and bundle replay).
	Fetch string `json:"fetch,omitempty"`
	// BaseReserve is the network's base reserve in stroops (default 5000000).
	BaseReserve *uint32 `json:"base_reserve,omitempty"`
	// Entries seed the fork layer before the network config is loaded.
	Entries []PutEntry `json:"entries,omitempty"`
	// SessionID names the session or bundle; each call's PRNG seed derives
	// from it and the call index (#537).
	SessionID string `json:"session_id,omitempty"`
	// CallIndex is the index of the session's next call, so a session
	// resumed in a new process continues its seeds instead of repeating them.
	CallIndex uint64 `json:"call_index,omitempty"`
}

// LedgerOpenResult answers ledger_open.
type LedgerOpenResult struct {
	LedgerProtocol int             `json:"ledger_protocol"`
	Sequence       uint32          `json:"sequence"`
	NetworkConfig  json.RawMessage `json:"network_config,omitempty"`
}

// LedgerPutParams writes entries into the open ledger.
type LedgerPutParams struct {
	Entries []PutEntry `json:"entries"`
}

// LedgerPutResult answers ledger_put.
type LedgerPutResult struct {
	Written int `json:"written"`
}

// LedgerGetParams reads entries by key.
type LedgerGetParams struct {
	KeysXDR []string `json:"keys_xdr"`
}

// LedgerGetResult answers ledger_get.
type LedgerGetResult struct {
	Entries []GotEntry `json:"entries"`
}

// GotEntry is an entry read back with ledger_get, with where it came from.
type GotEntry struct {
	KeyXDR          string      `json:"key_xdr"`
	EntryXDR        *string     `json:"entry_xdr"`
	LiveUntilLedger *uint32     `json:"live_until_ledger,omitempty"`
	Provenance      *Provenance `json:"provenance,omitempty"`
}

// Provenance says where an entry in the store came from.
type Provenance struct {
	Source                string  `json:"source"` // "fork", "override" or "session"
	FetchedAtLedger       *uint32 `json:"fetchedAtLedger,omitempty"`
	LastModifiedLedgerSeq uint32  `json:"lastModifiedLedgerSeq"`
}

// LedgerCheckpointParams snapshots the ledger.
type LedgerCheckpointParams struct {
	Label string `json:"label,omitempty"`
}

// LedgerCheckpointResult answers ledger_checkpoint.
type LedgerCheckpointResult struct {
	Checkpoint string `json:"checkpoint"`
}

// LedgerRollbackParams restores a checkpoint.
type LedgerRollbackParams struct {
	Checkpoint string `json:"checkpoint"`
}

// LedgerImportParams replaces the ledger with a whole snapshot.
type LedgerImportParams struct {
	LedgerSequence  uint32     `json:"ledger_sequence"`
	LedgerTimestamp *uint64    `json:"ledger_timestamp,omitempty"`
	Entries         []PutEntry `json:"entries"`
}

// LedgerImportResult answers ledger_import.
type LedgerImportResult struct {
	Imported       int    `json:"imported"`
	LedgerSequence uint32 `json:"ledger_sequence"`
}

// ContractInstallParams installs an executable.
type ContractInstallParams struct {
	WasmBase64 string `json:"wasm_base64"`
	ContractID string `json:"contract_id,omitempty"`
}

// ContractInstallResult answers contract_install.
type ContractInstallResult struct {
	ContractID string `json:"contract_id"`
	WasmHash   string `json:"wasm_hash"`
}

// ContractSwapParams points an installed contract at another executable.
type ContractSwapParams struct {
	ContractID string `json:"contract_id"`
	WasmHash   string `json:"wasm_hash"`
	// Layer is "session" (the default) or "override".
	Layer string `json:"layer,omitempty"`
	// Mode is required for a CAP-85 instance: "instance" or "ref".
	Mode string `json:"mode,omitempty"`
}

// ContractSwapResult answers contract_swap.
type ContractSwapResult struct {
	ContractID       string  `json:"contract_id"`
	PreviousWasmHash *string `json:"previous_wasm_hash"`
	WasmHash         string  `json:"wasm_hash"`
	Mode             string  `json:"mode,omitempty"`
	Layer            string  `json:"layer,omitempty"`
}

// ContractInfoParams reads a contract without running it (#550).
type ContractInfoParams struct {
	ContractID string `json:"contract_id"`
}

// ContractInfoResult answers contract_info.
type ContractInfoResult struct {
	ContractID        string       `json:"contract_id"`
	Executable        string       `json:"executable"` // wasm, stellar_asset or external_ref
	WasmHash          *string      `json:"wasm_hash"`
	ExternalRef       *ExternalRef `json:"external_ref,omitempty"`
	StorageEntries    int          `json:"storage_entries"`
	InstanceLiveUntil *uint32      `json:"instance_live_until,omitempty"`
	WasmSize          int          `json:"wasm_size,omitempty"`
	Misses            []string     `json:"misses"`
}

// ExternalRef is a CAP-85 executable reference.
type ExternalRef struct {
	Owner string `json:"owner"`
	Tag   string `json:"tag"`
}

// SimulateParams runs a function with JSON arguments (#545).
type SimulateParams struct {
	ContractID    string `json:"contract_id"`
	Function      string `json:"function"`
	Args          any    `json:"args"` // a map by argument name, or a slice in order
	SourceAccount string `json:"source_account,omitempty"`
	Diagnostics   bool   `json:"diagnostics,omitempty"`
	DryRun        bool   `json:"dry_run,omitempty"`
	// Budget overrides the network's limits, each up to 10x (#536).
	Budget *Budget `json:"budget,omitempty"`
	// AuthMode is record (the default), strict or enforce; enforce checks
	// AuthEntries, pre-signed SorobanAuthorizationEntry XDR (#557).
	AuthMode    string   `json:"auth_mode,omitempty"`
	AuthEntries []string `json:"auth_entries,omitempty"`
	// Ledger runs this call at another sequence or time (#558).
	Ledger *LedgerOverride `json:"ledger,omitempty"`
	// Trace asks for the call tree (#541): true, or a *TraceOptions.
	Trace any `json:"trace,omitempty"`
	// Related, false, keeps the call to its own contract: reaching another
	// contract's instance fails with fetch_failed / related (#552).
	Related *bool `json:"related,omitempty"`
}

// RelatedContract is another contract a call reached (#552).
type RelatedContract struct {
	ContractID string `json:"contract_id"`
	// Executable is wasm, stellar_asset or external_ref; empty if unread.
	Executable string `json:"executable,omitempty"`
	// Asset is a Stellar Asset Contract's: native, or CODE:ISSUER.
	Asset string `json:"asset,omitempty"`
}

// TraceOptions caps a trace's frames (default 10,000).
type TraceOptions struct {
	MaxFrames int `json:"max_frames,omitempty"`
}

// Trace is a call's call tree (#541), schema/v1/trace.json: read from the
// host's fn_call / fn_return diagnostics, so there are no per-frame
// instruction counts.
type Trace struct {
	Version int    `json:"version"`
	Source  string `json:"source"`
	Ledger  uint32 `json:"ledger"`
	// Seeded is set when the run saw state the network does not have.
	Seeded     bool           `json:"seeded"`
	Frames     []TraceFrame   `json:"frames"`
	FrameCount int            `json:"frame_count"`
	MaxFrames  int            `json:"max_frames"`
	Truncated  bool           `json:"truncated"`
	Storage    []TraceStorage `json:"storage"`
}

// TraceFrame is one contract call; frames are in call order.
type TraceFrame struct {
	Index    int      `json:"index"`
	Parent   *int     `json:"parent"`
	Depth    int      `json:"depth"`
	Contract string   `json:"contract"`
	Function string   `json:"function"`
	WasmHash *string  `json:"wasm_hash"`
	ArgsXDR  []string `json:"args_xdr"`
	// ArgsExact is false when no spec said how many arguments a folded
	// vec held.
	ArgsExact bool    `json:"args_exact"`
	ResultXDR *string `json:"result_xdr"`
	Error     *string `json:"error"`
}

// TraceStorage is the footprint of one contract; Contract is nil for keys
// of no one contract.
type TraceStorage struct {
	Contract  *string  `json:"contract"`
	ReadOnly  []string `json:"read_only"`
	ReadWrite []string `json:"read_write"`
	Changed   []string `json:"changed"`
}

// LedgerOverride is the ledger one call runs at; an unset field stays the
// session's.
type LedgerOverride struct {
	Sequence  *uint32 `json:"sequence,omitempty"`
	Timestamp *uint64 `json:"timestamp,omitempty"`
}

// Budget is a call's CPU and memory limits.
type Budget struct {
	Instructions uint64 `json:"instructions,omitempty"`
	MemBytes     uint64 `json:"mem_bytes,omitempty"`
	// Unlimited makes a limit not given the 10x ceiling (#558); requests
	// only.
	Unlimited bool `json:"unlimited,omitempty"`
}

// SimulateResult answers a simulate that executed, whatever it returned.
type SimulateResult struct {
	ReturnValueXDR string          `json:"return_value_xdr"`
	ReturnValue    json.RawMessage `json:"return_value,omitempty"`
	Events         []Event         `json:"events"`
	Cost           Cost            `json:"cost"`
	Logs           []string        `json:"logs"`

	DiagnosticEvents []string        `json:"diagnostic_events,omitempty"`
	Auth             []string        `json:"auth,omitempty"`
	AuthEntries      []AuthEntry     `json:"auth_entries,omitempty"`
	ModifiedEntries  []ModifiedEntry `json:"modified_entries,omitempty"`
	Resources        *Resources      `json:"resources,omitempty"`
	Fee              *Fee            `json:"fee,omitempty"`
	// Misses are the keys this call fetched (#531), for prefetching.
	Misses []string    `json:"misses,omitempty"`
	Ledger *LedgerInfo `json:"ledger,omitempty"`
	// Seed is the call's PRNG seed, hex (#537).
	Seed string `json:"seed,omitempty"`
	// Budget is set when the call ran under an override.
	Budget *Budget `json:"budget,omitempty"`
	// AuthMode is how require_auth was answered.
	AuthMode string `json:"auth_mode,omitempty"`
	// Archived are the archived entries the call read (#558).
	Archived []Archived `json:"archived,omitempty"`
	Trace    *Trace     `json:"trace,omitempty"`
	// Contracts are the other contracts the call reached (#552).
	Contracts []RelatedContract `json:"contracts,omitempty"`
}

// Event is one contract event, as XDR, with its spec decoding when there
// is one.
type Event struct {
	Type     string          `json:"type"`
	EventXDR string          `json:"event_xdr"`
	Decoded  json.RawMessage `json:"decoded,omitempty"`
}

// AuthEntry is a recorded auth entry in plain terms.
type AuthEntry struct {
	Credentials  string `json:"credentials"`
	Address      string `json:"address,omitempty"`
	RootFunction struct {
		Kind       string `json:"kind"`
		ContractID string `json:"contract_id,omitempty"`
		Function   string `json:"function,omitempty"`
	} `json:"root_function"`
	SubInvocations int `json:"sub_invocations"`
}

// ModifiedEntry is one entry a call wrote: nil BeforeXDR is a creation, nil
// AfterXDR a deletion.
type ModifiedEntry struct {
	KeyXDR          string  `json:"key_xdr"`
	BeforeXDR       *string `json:"before_xdr"`
	AfterXDR        *string `json:"after_xdr"`
	LiveUntilLedger *uint32 `json:"live_until_ledger,omitempty"`
}

// AppliedEntry is one write ledger_apply puts in the session layer; a nil
// EntryXDR deletes the key.
type AppliedEntry struct {
	KeyXDR          string  `json:"key_xdr"`
	EntryXDR        *string `json:"entry_xdr"`
	LiveUntilLedger *uint32 `json:"live_until_ledger,omitempty"`
}

// LedgerApplyParams restores session writes (#555).
type LedgerApplyParams struct {
	Entries []AppliedEntry `json:"entries"`
}

// LedgerApplyResult answers ledger_apply.
type LedgerApplyResult struct {
	Applied int `json:"applied"`
}

// Resources is what the call needs, from its simulated transaction data.
type Resources struct {
	Instructions  uint32    `json:"instructions"`
	DiskReadBytes uint32    `json:"disk_read_bytes"`
	WriteBytes    uint32    `json:"write_bytes"`
	Footprint     Footprint `json:"footprint"`
}

// Footprint is the keys a call reads and writes.
type Footprint struct {
	ReadOnly  []string `json:"read_only"`
	ReadWrite []string `json:"read_write"`
}

// Fee is the call's raw resource fee in stroops (no RPC adjustment).
type Fee struct {
	ResourceFee int64 `json:"resource_fee"`
}

// Cost is what a call consumed.
type Cost struct {
	CPUInsns uint64 `json:"cpu_insns"`
	MemBytes uint64 `json:"mem_bytes"`
}

// Source names an executable: inline WASM or an installed contract. Exactly
// one field is set.
type Source struct {
	WasmBase64 string `json:"wasm_base64,omitempty"`
	ContractID string `json:"contract_id,omitempty"`
}

// SpecExtractParams reads the spec out of an executable.
type SpecExtractParams struct {
	Source Source `json:"source"`
}

// SpecExtractResult answers spec_extract. Spec is the whole SpecJson v1
// document (packages/spec/schema/spec-json.v1.schema.json), kept as JSON.
type SpecExtractResult struct {
	SpecEntriesXDR []string        `json:"spec_entries_xdr"`
	WasmHash       string          `json:"wasm_hash"`
	Spec           json.RawMessage `json:"spec"`
}

// SpecEncodeArgsParams encodes JSON arguments to ScVals from a spec. Args is
// a map keyed by argument name, or a slice in declaration order, in
// @signet/spec's functionArgsSchema shape.
type SpecEncodeArgsParams struct {
	Source   Source `json:"source"`
	Function string `json:"function"`
	Args     any    `json:"args"`
}

// SpecEncodeArgsResult answers spec_encode_args.
type SpecEncodeArgsResult struct {
	ArgsXDR []string `json:"args_xdr"`
}

// SpecDecodeValParams decodes XDR with a contract's spec: ValXDR as
// Function's return type or as the named AsType, or EventXDR as a contract
// event. Set exactly one of those three combinations.
type SpecDecodeValParams struct {
	Source   Source `json:"source"`
	Function string `json:"function,omitempty"`
	AsType   string `json:"as_type,omitempty"`
	ValXDR   string `json:"val_xdr,omitempty"`
	EventXDR string `json:"event_xdr,omitempty"`
}

// SpecDecodeValResult answers spec_decode_val.
type SpecDecodeValResult struct {
	Value json.RawMessage `json:"value"`
}

// SpecDiffParams compares the interfaces of two executables.
type SpecDiffParams struct {
	Old Source `json:"old"`
	New Source `json:"new"`
}

// SpecDiffResult answers spec_diff. Changes are kept as JSON until a
// command needs their shape (#570).
type SpecDiffResult struct {
	Compatible bool              `json:"compatible"`
	Changes    []json.RawMessage `json:"changes"`
}

// LayoutCheckParams checks that stored-data layout survives an upgrade.
type LayoutCheckParams struct {
	Old Source `json:"old"`
	New Source `json:"new"`
}

// LayoutCheckResult answers layout_check.
type LayoutCheckResult struct {
	Compatible bool              `json:"compatible"`
	Issues     []json.RawMessage `json:"issues"`
}

// DiffResultsParams compares two simulate result bodies.
type DiffResultsParams struct {
	Left  SimulateResult `json:"left"`
	Right SimulateResult `json:"right"`
}

// DiffResultsResult answers diff_results.
type DiffResultsResult struct {
	Equal       bool              `json:"equal"`
	Differences []json.RawMessage `json:"differences"`
}

// XDRKey asks xdr_keys for one key. Kind is "contract_instance",
// "contract_code", "account", "config_setting" or "network_config"; the
// other fields are the ones that kind needs.
type XDRKey struct {
	Kind       string `json:"kind"`
	ContractID string `json:"contract_id,omitempty"`
	WasmHash   string `json:"wasm_hash,omitempty"`
	AccountID  string `json:"account_id,omitempty"`
	Setting    string `json:"setting,omitempty"`
}

// XDRKeysParams builds the ledger keys Go asks RPC for (#532).
type XDRKeysParams struct {
	LedgerProtocol *int     `json:"ledger_protocol,omitempty"`
	Keys           []XDRKey `json:"keys"`
}

// XDRKeysResult answers xdr_keys.
type XDRKeysResult struct {
	Keys []BuiltKey `json:"keys"`
}

// BuiltKey is one key xdr_keys built.
type BuiltKey struct {
	Kind    string `json:"kind"`
	Subject string `json:"subject"`
	KeyXDR  string `json:"key_xdr"`
}

// TxDecodeParams decodes a transaction envelope and, optionally, its meta.
type TxDecodeParams struct {
	LedgerProtocol *int   `json:"ledger_protocol,omitempty"`
	TransactionXDR string `json:"transaction_xdr"`
	ResultMetaXDR  string `json:"result_meta_xdr,omitempty"`
}

// TxDecodeResult answers tx_decode. The transaction stays JSON until a
// command needs its shape (#635).
type TxDecodeResult struct {
	Transaction json.RawMessage `json:"transaction"`
}

// WasmInspectParams reports what an executable declares.
type WasmInspectParams struct {
	LedgerProtocol *int   `json:"ledger_protocol,omitempty"`
	WasmBase64     string `json:"wasm_base64"`
}

// WasmInspectResult answers wasm_inspect.
type WasmInspectResult struct {
	WasmHash         string            `json:"wasm_hash"`
	SizeBytes        int               `json:"size_bytes"`
	CustomSections   []string          `json:"custom_sections"`
	InterfaceVersion *InterfaceVersion `json:"interface_version"`
	Exports          []string          `json:"exports"`
	Imports          []WasmImport      `json:"imports"`
	// Upgradeable is wasm, executable-ref or none: whether the executable
	// can replace its own code on-chain (#540).
	Upgradeable string `json:"upgradeable"`
}

// InterfaceVersion is contractenvmetav0's interface version; nil when the
// executable declares none.
type InterfaceVersion struct {
	Protocol   uint32 `json:"protocol"`
	PreRelease uint32 `json:"pre_release"`
}

// WasmImport is one imported host function.
type WasmImport struct {
	Module string `json:"module"`
	Name   string `json:"name"`
}

// StatusResult answers status.
type StatusResult struct {
	UptimeMS       uint64          `json:"uptime_ms"`
	LedgerOpen     bool            `json:"ledger_open"`
	LedgerSequence *uint32         `json:"ledger_sequence"`
	Entries        int             `json:"entries"`
	Contracts      int             `json:"contracts"`
	NetworkConfig  json.RawMessage `json:"network_config,omitempty"`
	BaseReserve    *uint32         `json:"base_reserve,omitempty"`
}

// SnapshotReadParams hands the simulator a `stellar snapshot create` file
// (#554).
type SnapshotReadParams struct {
	SnapshotJSON string `json:"snapshot_json"`
}

// SnapshotReadResult is the ledger a snapshot was taken at and its entries,
// in the RPC form a fork cache holds.
type SnapshotReadResult struct {
	ProtocolVersion       int             `json:"protocol_version"`
	SequenceNumber        uint32          `json:"sequence_number"`
	Timestamp             uint64          `json:"timestamp"`
	NetworkID             string          `json:"network_id"`
	BaseReserve           uint32          `json:"base_reserve"`
	MinPersistentEntryTTL uint32          `json:"min_persistent_entry_ttl"`
	MinTempEntryTTL       uint32          `json:"min_temp_entry_ttl"`
	MaxEntryTTL           uint32          `json:"max_entry_ttl"`
	Entries               []SnapshotEntry `json:"entries"`
}

// SnapshotEntry is one entry of a snapshot, as RPC would give it.
type SnapshotEntry struct {
	KeyXDR                string  `json:"key_xdr"`
	DataXDR               string  `json:"data_xdr"`
	LastModifiedLedgerSeq uint32  `json:"last_modified_ledger_seq"`
	ExtXDR                string  `json:"ext_xdr"`
	LiveUntilLedger       *uint32 `json:"live_until_ledger"`
}

// EntriesDescribeParams asks for entries in plain terms (#554).
type EntriesDescribeParams struct {
	Entries        []DescribeEntry `json:"entries"`
	LedgerProtocol *int            `json:"ledger_protocol,omitempty"`
}

// DescribeEntry is an entry in the RPC form.
type DescribeEntry struct {
	DataXDR               string `json:"data_xdr"`
	LastModifiedLedgerSeq uint32 `json:"last_modified_ledger_seq"`
	ExtXDR                string `json:"ext_xdr,omitempty"`
}

// EntriesDescribeResult is each entry in plain terms, in order.
type EntriesDescribeResult struct {
	Entries []DescribedEntry `json:"entries"`
}

// DescribedEntry is one entry in plain terms: an instance with its storage
// map, contract data with durability, key and value, or code by hash.
type DescribedEntry struct {
	Kind       string          `json:"kind"`
	Contract   string          `json:"contract,omitempty"`
	Durability string          `json:"durability,omitempty"`
	Key        json.RawMessage `json:"key,omitempty"`
	Value      json.RawMessage `json:"value,omitempty"`
	Executable string          `json:"executable,omitempty"`
	Storage    []struct {
		Key   json.RawMessage `json:"key"`
		Value json.RawMessage `json:"value"`
	} `json:"storage,omitempty"`
	Hash  string `json:"hash,omitempty"`
	Bytes int    `json:"bytes,omitempty"`
}

// StorageOverrideParams sets or removes one storage entry of a contract in
// the override layer (#559). Key and Value are storage expressions.
type StorageOverrideParams struct {
	ContractID string  `json:"contract_id"`
	Durability string  `json:"durability"`
	Key        string  `json:"key"`
	Value      string  `json:"value,omitempty"`
	Unset      bool    `json:"unset,omitempty"`
	LiveUntil  *uint32 `json:"live_until,omitempty"`
}

// StorageOverrideResult is what an override wrote.
type StorageOverrideResult struct {
	KeyXDR          string  `json:"key_xdr"`
	Key             string  `json:"key"`
	Removed         bool    `json:"removed"`
	LiveUntilLedger *uint32 `json:"live_until_ledger"`
}
