// Package bundle is signet dev's session log and the repro bundle exported
// from it (#572): one JSON file someone else can re-run offline and get
// byte-identical results from. The bundle's schema is
// sandbox/protocol/schema/v1/bundle.json.
//
// A session log is NDJSON under .signet/sessions/<timestamp>.ndjson: a
// session record, then a wasm record per distinct build and a cycle record
// per reload cycle. Export reads it with the fork cache's entries.
package bundle

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/devconfig"
	"github.com/blockchain-maxis/signet/cli/internal/fork"
)

// Version is the bundle format version.
const Version = 1

// DefaultMaxSize is the export size cap.
const DefaultMaxSize = 25 << 20

// SessionsDir is where session logs go, under the contract's directory.
const SessionsDir = ".signet/sessions"

// Wasm is an executable with its hash.
type Wasm struct {
	SHA256 string `json:"sha256"`
	Base64 string `json:"base64"`
}

// WasmOf is w's Wasm.
func WasmOf(w []byte) Wasm {
	sum := sha256.Sum256(w)
	return Wasm{SHA256: hex.EncodeToString(sum[:]), Base64: base64.StdEncoding.EncodeToString(w)}
}

// Network is the network a session ran against.
type Network struct {
	Name       string `json:"name,omitempty"`
	Passphrase string `json:"passphrase"`
	Protocol   int    `json:"protocol"`
}

// Session is a session log's first record.
type Session struct {
	Type      string  `json:"type"` // session
	Started   string  `json:"started"`
	CreatedBy string  `json:"createdBy"`
	Contract  string  `json:"contract"`
	Network   Network `json:"network"`
	Fork      struct {
		ID         string `json:"id"`
		Ledger     uint32 `json:"ledger"`
		Timestamp  uint64 `json:"timestamp"`
		Consistent bool   `json:"consistent"`
	} `json:"fork"`
	Simulator Simulator `json:"simulator"`
	Deployed  Wasm      `json:"deployed"`
}

// Simulator is the build and lane a session ran on.
type Simulator struct {
	Version string `json:"version"`
	Lane    int    `json:"lane"`
}

// Call is a call a cycle ran.
type Call struct {
	Name     string         `json:"name"`
	Function string         `json:"function"`
	Args     map[string]any `json:"args"`
	Chain    bool           `json:"chain,omitempty"`
	Expect   string         `json:"expect,omitempty"`
	Source   string         `json:"source"` // saved or real
	// A real transaction's replay (#636) sends its arguments as XDR, from
	// its source account; Tx is its hash.
	ArgsXDR       []string `json:"args_xdr,omitempty"`
	SourceAccount string   `json:"source_account,omitempty"`
	Tx            string   `json:"tx,omitempty"`
}

// Override is a storage override a cycle ran under, as signet.dev.toml
// gives it.
type Override struct {
	Durability string `json:"durability"`
	Key        string `json:"key"`
	Value      string `json:"value,omitempty"`
	Unset      bool   `json:"unset,omitempty"`
}

// OverridesOf are a file's overrides in bundle form.
func OverridesOf(overrides []devconfig.Override) []Override {
	out := make([]Override, len(overrides))
	for i, o := range overrides {
		out[i] = Override{Durability: o.Durability, Key: o.Key, Value: o.Value, Unset: o.Unset}
	}
	return out
}

// Side is what a call returned on one side.
type Side struct {
	Outcome        string `json:"outcome"` // ok or error
	ReturnValueXDR string `json:"return_value_xdr,omitempty"`
	Error          string `json:"error,omitempty"`
}

// Expected is a call's result on the deployed code (A) and the build (B).
type Expected struct {
	Name string `json:"name"`
	A    Side   `json:"a"`
	B    Side   `json:"b"`
}

// Cycle is one reload cycle's record.
type Cycle struct {
	Type      string     `json:"type"` // cycle
	At        string     `json:"at"`
	Local     string     `json:"local"`
	Calls     []Call     `json:"calls"`
	Overrides []Override `json:"overrides"`
	Expected  []Expected `json:"expected"`
	// Keys are every key a footprint read this cycle, base64 XDR.
	Keys []string `json:"keys"`
}

// Log appends a session's records.
type Log struct {
	mu     sync.Mutex
	path   string
	builds map[string]bool
}

// NewLog starts a session log under dir/.signet/sessions with s as its
// first record.
func NewLog(dir string, s Session, now time.Time) (*Log, error) {
	sessions := filepath.Join(dir, filepath.FromSlash(SessionsDir))
	if err := os.MkdirAll(sessions, 0o755); err != nil {
		return nil, err
	}
	s.Type, s.Started = "session", now.UTC().Format(time.RFC3339)
	l := &Log{path: filepath.Join(sessions, now.UTC().Format("20060102T150405.000Z")+".ndjson"), builds: map[string]bool{}}
	return l, l.append(s)
}

// Path is the log's file.
func (l *Log) Path() string { return l.path }

// Cycle records a cycle on build, writing the build first if it is new.
func (l *Log) Cycle(build []byte, c Cycle, now time.Time) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	w := WasmOf(build)
	if !l.builds[w.SHA256] {
		if err := l.appendLocked(struct {
			Type string `json:"type"`
			Wasm
		}{"wasm", w}); err != nil {
			return err
		}
		l.builds[w.SHA256] = true
	}
	c.Type, c.At, c.Local = "cycle", now.UTC().Format(time.RFC3339), w.SHA256
	return l.appendLocked(c)
}

func (l *Log) append(v any) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.appendLocked(v)
}

func (l *Log) appendLocked(v any) error {
	line, err := json.Marshal(v)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(line, '\n')); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

// Latest is the newest session log under dir, or "" when there is none.
func Latest(dir string) (string, error) {
	sessions := filepath.Join(dir, filepath.FromSlash(SessionsDir))
	entries, err := os.ReadDir(sessions)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".ndjson") {
			names = append(names, e.Name())
		}
	}
	if len(names) == 0 {
		return "", nil
	}
	sort.Strings(names)
	return filepath.Join(sessions, names[len(names)-1]), nil
}

// Read loads a session log: its session record, builds by hash, and cycles
// in order.
func Read(path string) (Session, map[string]Wasm, []Cycle, error) {
	var (
		s      Session
		builds = map[string]Wasm{}
		cycles []Cycle
	)
	f, err := os.Open(path)
	if err != nil {
		return s, nil, nil, err
	}
	defer func() { _ = f.Close() }()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<30)
	for n := 1; sc.Scan(); n++ {
		var head struct {
			Type string `json:"type"`
		}
		line := sc.Bytes()
		if err := json.Unmarshal(line, &head); err != nil {
			return s, nil, nil, fmt.Errorf("%s:%d: %v", path, n, err)
		}
		switch head.Type {
		case "session":
			err = json.Unmarshal(line, &s)
		case "wasm":
			var w Wasm
			if err = json.Unmarshal(line, &w); err == nil {
				builds[w.SHA256] = w
			}
		case "cycle":
			var c Cycle
			if err = json.Unmarshal(line, &c); err == nil {
				cycles = append(cycles, c)
			}
		default:
			err = fmt.Errorf("unknown record type %q", head.Type)
		}
		if err != nil {
			return s, nil, nil, fmt.Errorf("%s:%d: %v", path, n, err)
		}
	}
	if err := sc.Err(); err != nil {
		return s, nil, nil, err
	}
	if s.Type != "session" {
		return s, nil, nil, fmt.Errorf("%s has no session record", path)
	}
	return s, builds, cycles, nil
}

// Entry is a ledger entry in a bundle.
type Entry struct {
	Key                   string  `json:"key"`
	Entry                 string  `json:"entry"`
	Ext                   string  `json:"ext,omitempty"`
	LastModifiedLedgerSeq uint32  `json:"lastModifiedLedgerSeq"`
	LiveUntil             *uint32 `json:"liveUntil"`
}

// Bundle is a repro bundle, v1.
type Bundle struct {
	Version   int     `json:"version"`
	CreatedBy string  `json:"createdBy"`
	Network   Network `json:"network"`
	Fork      struct {
		Contract   string   `json:"contract"`
		Ledger     uint32   `json:"ledger"`
		Consistent bool     `json:"consistent"`
		Drifted    []string `json:"drifted"`
	} `json:"fork"`
	LedgerInfo struct {
		Sequence  uint32 `json:"sequence"`
		Timestamp uint64 `json:"timestamp"`
	} `json:"ledgerInfo"`
	ConfigSettings []Entry `json:"configSettings"`
	Entries        []Entry `json:"entries"`
	// Absent are keys the session read and found no entry at, so a replay
	// with fetching denied reads them as absent too.
	Absent []string `json:"absent,omitempty"`
	Wasm   struct {
		Deployed Wasm `json:"deployed"`
		Local    Wasm `json:"local"`
	} `json:"wasm"`
	Calls      []Call     `json:"calls"`
	Overrides  []Override `json:"overrides"`
	Expected   []Expected `json:"expected"`
	Simulator  Simulator  `json:"simulator"`
	BundleHash string     `json:"bundleHash,omitempty"`
}

// configSetting reports whether a LedgerKey (base64 XDR) is a
// CONFIG_SETTING key: its type discriminant, the first four bytes, is 8.
func configSetting(key string) bool {
	raw, err := base64.StdEncoding.DecodeString(key)
	return err == nil && len(raw) >= 4 && raw[0] == 0 && raw[1] == 0 && raw[2] == 0 && raw[3] == 8
}

func entryOf(e fork.Entry) Entry {
	return Entry{Key: e.Key, Entry: e.XDR, Ext: e.ExtXDR, LastModifiedLedgerSeq: e.LastModifiedLedgerSeq, LiveUntil: e.LiveUntilLedgerSeq}
}

// Build assembles the bundle for a session's last cycle: its calls,
// overrides, results and build, with the entries every cycle's footprints
// read and the network config, out of the fork cache's entries.
func Build(s Session, builds map[string]Wasm, cycles []Cycle, cached []fork.Entry) (*Bundle, error) {
	if len(cycles) == 0 {
		return nil, fmt.Errorf("the session ran no cycle: run signet dev until a build replays, then export")
	}
	last := cycles[len(cycles)-1]
	local, ok := builds[last.Local]
	if !ok {
		return nil, fmt.Errorf("the session log has no build %s", last.Local)
	}
	read := map[string]bool{}
	for _, c := range cycles {
		for _, k := range c.Keys {
			read[k] = true
		}
	}
	b := &Bundle{Version: Version, CreatedBy: s.CreatedBy, Network: Network{Passphrase: s.Network.Passphrase, Protocol: s.Network.Protocol}}
	b.Fork.Contract, b.Fork.Ledger, b.Fork.Consistent = s.Contract, s.Fork.Ledger, s.Fork.Consistent
	b.Fork.Drifted = []string{}
	b.LedgerInfo.Sequence, b.LedgerInfo.Timestamp = s.Fork.Ledger, s.Fork.Timestamp
	b.ConfigSettings, b.Entries = []Entry{}, []Entry{}
	have := map[string]bool{}
	for _, e := range cached {
		have[e.Key] = true
		switch {
		case configSetting(e.Key):
			b.ConfigSettings = append(b.ConfigSettings, entryOf(e))
		case read[e.Key]:
			b.Entries = append(b.Entries, entryOf(e))
			if e.Drifted {
				b.Fork.Drifted = append(b.Fork.Drifted, e.Key)
			}
		}
	}
	byKey := func(es []Entry) {
		sort.Slice(es, func(i, j int) bool { return es[i].Key < es[j].Key })
	}
	for k := range read {
		if !have[k] {
			b.Absent = append(b.Absent, k)
		}
	}
	sort.Strings(b.Absent)
	byKey(b.ConfigSettings)
	byKey(b.Entries)
	sort.Strings(b.Fork.Drifted)
	b.Wasm.Deployed, b.Wasm.Local = s.Deployed, local
	b.Calls, b.Overrides, b.Expected = last.Calls, last.Overrides, last.Expected
	if b.Overrides == nil {
		b.Overrides = []Override{}
	}
	b.Simulator = s.Simulator
	hash, err := Hash(b)
	if err != nil {
		return nil, err
	}
	b.BundleHash = hash
	return b, nil
}

// Canonical is b's canonical JSON: keys sorted, no whitespace, without
// bundleHash.
func Canonical(b *Bundle) ([]byte, error) {
	c := *b
	c.BundleHash = ""
	raw, err := json.Marshal(c)
	if err != nil {
		return nil, err
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	return json.Marshal(v) // maps marshal with sorted keys
}

// Hash is the sha256 of b's canonical JSON.
func Hash(b *Bundle) (string, error) {
	raw, err := Canonical(b)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// TooLargeError is an export over the cap, with what takes the room.
type TooLargeError struct {
	Size, Max int
	Parts     []Part
}

// Part is one item of a bundle's size.
type Part struct {
	What  string
	Bytes int
}

func (e *TooLargeError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "the bundle is %s, over the %s cap (--max-size). The largest parts:", size(e.Size), size(e.Max))
	for _, p := range e.Parts {
		fmt.Fprintf(&b, "\n  %-48s %s", p.What, size(p.Bytes))
	}
	return b.String()
}

func size(n int) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}

// Encode is b as the file export writes, refused over max bytes with the
// parts that dominate: each executable, and the biggest entries.
func Encode(b *Bundle, max int) ([]byte, error) {
	out, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return nil, err
	}
	out = append(out, '\n')
	if len(out) <= max {
		return out, nil
	}
	parts := []Part{
		{"wasm.deployed (" + b.Wasm.Deployed.SHA256[:8] + ")", len(b.Wasm.Deployed.Base64)},
		{"wasm.local (" + b.Wasm.Local.SHA256[:8] + ")", len(b.Wasm.Local.Base64)},
	}
	for _, group := range []struct {
		name    string
		entries []Entry
	}{{"entries", b.Entries}, {"configSettings", b.ConfigSettings}} {
		for _, e := range group.entries {
			parts = append(parts, Part{group.name + " " + e.Key[:min(16, len(e.Key))] + "…", len(e.Entry) + len(e.Key)})
		}
	}
	sort.SliceStable(parts, func(i, j int) bool { return parts[i].Bytes > parts[j].Bytes })
	if len(parts) > 8 {
		parts = parts[:8]
	}
	return nil, &TooLargeError{Size: len(out), Max: max, Parts: parts}
}
