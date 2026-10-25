// Package devconfig reads signet.dev.toml (#560): a contract's saved calls,
// replay settings, diff rules and storage overrides, committed with the
// contract so a teammate or CI runs the same checks.
//
// Decoding is strict: a key the schema does not have is an error naming its
// line, so a typo never silently turns a check off. The schema is in
// docs/SANDBOX.md and, for editors (Taplo), in
// sandbox/protocol/schema/v1/signet-dev-toml.json.
//
//	version = 1
//	network = "testnet"          # or [network] rpc_url / passphrase
//	address = "CASF…RCN"
//	path = "./contracts/registry"   # crate dir; optional package = "identity-registry"
//
//	[replay]
//	saved = true
//	recent_transactions = 20     # 0 disables
//	include_failed = false
//
//	[[call]]
//	name = "count is stable"
//	function = "count"
//	args = {}
//	expect = "unchanged"         # unchanged | ok | error:<Name> | any
//
//	[[override]]
//	durability = "persistent"
//	key = 'Owner("alice")'
//	value = '"GABC…"'
//
//	[diff]
//	ignore_events = []
//	resource_tolerance = { instructions = "10%", fee = "10%" }
package devconfig

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/BurntSushi/toml"
)

// FileName is the file's name in a contract's directory.
const FileName = "signet.dev.toml"

// Version is the schema version this package reads.
const Version = 1

// File is a whole signet.dev.toml.
type File struct {
	Version int     `toml:"version"`
	Network Network `toml:"-"`
	Address string  `toml:"address"`
	// Path is the contract's crate directory; Package names the crate when
	// the directory is a workspace.
	Path      string     `toml:"path"`
	Package   string     `toml:"package"`
	Replay    Replay     `toml:"replay"`
	Calls     []Call     `toml:"call"`
	Overrides []Override `toml:"override"`
	Diff      Diff       `toml:"diff"`
}

// Network is `network = "testnet"`, or a [network] table naming an RPC.
type Network struct {
	Name       string `toml:"name"`
	RPCURL     string `toml:"rpc_url"`
	Passphrase string `toml:"passphrase"`
}

// Replay is which recorded calls a check replays.
type Replay struct {
	// Saved replays the [[call]]s; on unless set false.
	Saved *bool `toml:"saved"`
	// RecentTransactions replays the contract's last N transactions (0
	// disables); bounded by RPC retention.
	RecentTransactions *int `toml:"recent_transactions"`
	IncludeFailed      bool `toml:"include_failed"`
}

// Call is one saved call and what it should do.
type Call struct {
	Name     string         `toml:"name"`
	Function string         `toml:"function"`
	Args     map[string]any `toml:"args"`
	Expect   Expect         `toml:"expect"`
}

// Expect is what a saved call should do: unchanged (the same result as
// before), ok, error:<Name> (that contract error), or any.
type Expect struct {
	Kind  string // unchanged, ok, error, any
	Error string // for Kind error: the contract error's name
}

// UnmarshalText reads `unchanged`, `ok`, `error:<Name>` or `any`.
func (e *Expect) UnmarshalText(text []byte) error {
	s := string(text)
	switch s {
	case "unchanged", "ok", "any":
		*e = Expect{Kind: s}
		return nil
	}
	if name, ok := strings.CutPrefix(s, "error:"); ok && identifier.MatchString(name) {
		*e = Expect{Kind: "error", Error: name}
		return nil
	}
	return fmt.Errorf("expect must be unchanged, ok, error:<Name> or any, not %q", s)
}

// MarshalText writes the form UnmarshalText reads.
func (e Expect) MarshalText() ([]byte, error) {
	if e.Kind == "error" {
		return []byte("error:" + e.Error), nil
	}
	return []byte(e.Kind), nil
}

// Override is one storage override (#559): durability, key, and value or
// unset = true.
type Override struct {
	Durability string `toml:"durability"`
	Key        string `toml:"key"`
	Value      string `toml:"value"`
	Unset      bool   `toml:"unset"`
}

// Diff is what a comparison leaves out or tolerates.
type Diff struct {
	// IgnoreEvents are event topic prefixes a diff leaves out.
	IgnoreEvents []string `toml:"ignore_events"`
	// ResourceTolerance is how far a resource may move before it counts as
	// a change, as a percentage: { instructions = "10%", fee = "10%" }.
	ResourceTolerance map[string]string `toml:"resource_tolerance"`
}

// ToleranceResources are the resources a tolerance may name.
var ToleranceResources = []string{"instructions", "read_bytes", "write_bytes", "fee"}

var (
	identifier = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	percent    = regexp.MustCompile(`^\d+(\.\d+)?%$`)
	contractID = regexp.MustCompile(`^C[A-Z2-7]{55}$`)
)

// Error is a problem in the file, with its line when one is known.
type Error struct {
	Path string
	Line int
	Msg  string
}

func (e *Error) Error() string {
	if e.Line > 0 {
		return fmt.Sprintf("%s:%d: %s", e.Path, e.Line, e.Msg)
	}
	return fmt.Sprintf("%s: %s", e.Path, e.Msg)
}

// Errors is every problem found, in file order.
type Errors []*Error

func (es Errors) Error() string {
	lines := make([]string, len(es))
	for i, e := range es {
		lines[i] = e.Error()
	}
	return strings.Join(lines, "\n")
}

// Load reads and checks a signet.dev.toml.
func Load(path string) (*File, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(path, raw)
}

// Parse reads and checks the text of a signet.dev.toml; path is for
// messages.
func Parse(path string, raw []byte) (*File, error) {
	var doc struct {
		File
		Network toml.Primitive `toml:"network"`
	}
	md, err := toml.Decode(string(raw), &doc)
	if err != nil {
		var perr toml.ParseError
		if errors.As(err, &perr) {
			msg := strings.TrimSpace(perr.Message)
			if msg == "" {
				msg = perr.Error()
			}
			return nil, &Error{Path: path, Line: perr.Position.Line, Msg: msg}
		}
		return nil, &Error{Path: path, Msg: err.Error()}
	}
	f := doc.File
	var errs Errors
	if md.IsDefined("network") {
		var err error
		switch md.Type("network") {
		case "String":
			err = md.PrimitiveDecode(doc.Network, &f.Network.Name)
		default:
			err = md.PrimitiveDecode(doc.Network, &f.Network)
		}
		if err != nil {
			errs = append(errs, &Error{Path: path, Line: lineOf(raw, "network"), Msg: "network is a name (\"testnet\") or a table with rpc_url and passphrase"})
		}
	}
	for _, key := range md.Undecoded() {
		errs = append(errs, &Error{Path: path, Line: lineOf(raw, key.String()), Msg: fmt.Sprintf("unknown key %q", key.String())})
	}
	errs = append(errs, f.check(path, raw)...)
	if len(errs) > 0 {
		return nil, errs
	}
	return &f, nil
}

// check is what can be checked without the deployed contract.
func (f *File) check(path string, raw []byte) Errors {
	var errs Errors
	add := func(key, format string, args ...any) {
		errs = append(errs, &Error{Path: path, Line: lineOf(raw, key), Msg: fmt.Sprintf(format, args...)})
	}
	if f.Version != Version {
		add("version", "version must be %d, not %d", Version, f.Version)
	}
	if f.Address != "" && !contractID.MatchString(f.Address) {
		add("address", "address must be a contract id (C…), not %q", f.Address)
	}
	if f.Network.Name == "" && f.Network.RPCURL == "" && f.Network.Passphrase != "" {
		add("network", "a network passphrase needs an rpc_url")
	}
	if r := f.Replay.RecentTransactions; r != nil && *r < 0 {
		add("replay.recent_transactions", "recent_transactions must be 0 or more")
	}
	seen := map[string]bool{}
	for i, c := range f.Calls {
		where := fmt.Sprintf("call %d", i+1)
		switch {
		case strings.TrimSpace(c.Name) == "":
			add(where+".name", "%s needs a name", where)
		case seen[c.Name]:
			add(where+".name", "two calls are named %q; names must be unique", c.Name)
		}
		seen[c.Name] = true
		if !identifier.MatchString(c.Function) {
			add(where+".function", "%s (%q) needs a function name", where, c.Name)
		}
		if c.Expect.Kind == "" {
			add(where+".expect", "%s (%q) needs expect: unchanged, ok, error:<Name> or any", where, c.Name)
		}
	}
	for i, o := range f.Overrides {
		where := fmt.Sprintf("override %d", i+1)
		switch o.Durability {
		case "instance", "persistent", "temporary":
		default:
			add(where+".durability", "%s: durability must be instance, persistent or temporary, not %q", where, o.Durability)
		}
		if strings.TrimSpace(o.Key) == "" {
			add(where+".key", "%s needs a key", where)
		}
		if o.Unset == (o.Value != "") {
			add(where+".value", "%s needs a value, or unset = true, not both", where)
		}
	}
	for resource, tolerance := range f.Diff.ResourceTolerance {
		known := false
		for _, r := range ToleranceResources {
			known = known || r == resource
		}
		if !known {
			add("diff.resource_tolerance", "resource_tolerance names %q; it may name %s", resource, strings.Join(ToleranceResources, ", "))
		}
		if !percent.MatchString(tolerance) {
			add("diff.resource_tolerance", "resource_tolerance %s must be a percentage like \"10%%\", not %q", resource, tolerance)
		}
	}
	return errs
}

// Contract is what the deployed contract offers, for CheckCalls.
type Contract struct {
	// Functions are the spec's function names.
	Functions map[string]bool
	// EncodeArgs checks a call's arguments against the spec (#545): nil
	// when they encode, else why not.
	EncodeArgs func(function string, args map[string]any) error
	// Errors are the spec's contract error names.
	Errors map[string]bool
}

// CheckCalls checks the saved calls against the deployed contract: each
// function exists, its arguments encode, and an expected error is one the
// contract has.
func (f *File) CheckCalls(path string, c Contract) error {
	var errs Errors
	for i, call := range f.Calls {
		where := fmt.Sprintf("call %d (%q)", i+1, call.Name)
		if !c.Functions[call.Function] {
			errs = append(errs, &Error{Path: path, Msg: fmt.Sprintf("%s: the contract has no function %q", where, call.Function)})
			continue
		}
		if c.EncodeArgs != nil {
			if err := c.EncodeArgs(call.Function, call.Args); err != nil {
				errs = append(errs, &Error{Path: path, Msg: fmt.Sprintf("%s: %v", where, err)})
			}
		}
		if call.Expect.Kind == "error" && c.Errors != nil && !c.Errors[call.Expect.Error] {
			errs = append(errs, &Error{Path: path, Msg: fmt.Sprintf("%s: the contract has no error %q", where, call.Expect.Error)})
		}
	}
	if len(errs) > 0 {
		return errs
	}
	return nil
}

// lineOf finds the line a dotted key (`call.expect`, `call 2.name`,
// `diff.resource_tolerance`) is set on, by walking table headers; 0 when
// it cannot tell. `call 2` means the second [[call]].
func lineOf(raw []byte, key string) int {
	parts := strings.Split(key, ".")
	table, field := strings.Join(parts[:len(parts)-1], "."), parts[len(parts)-1]
	wantIndex := 0
	if name, n, ok := strings.Cut(table, " "); ok {
		table = name
		_, _ = fmt.Sscanf(n, "%d", &wantIndex)
	}
	current, index := "", map[string]int{}
	for i, line := range strings.Split(string(raw), "\n") {
		t := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(t, "[["):
			current = strings.TrimSpace(strings.Trim(strings.SplitN(t, "#", 2)[0], "[] \t"))
			index[current]++
			continue
		case strings.HasPrefix(t, "["):
			current = strings.TrimSpace(strings.Trim(strings.SplitN(t, "#", 2)[0], "[] \t"))
			continue
		}
		name, _, ok := strings.Cut(t, "=")
		if !ok || strings.TrimSpace(name) != field || current != table {
			continue
		}
		if wantIndex == 0 || index[current] == wantIndex {
			return i + 1
		}
	}
	return 0
}

// Encode writes the file back as TOML: `network` as a name when it is only
// a name, else as a table.
func (f *File) Encode() ([]byte, error) {
	out := struct {
		Version   int        `toml:"version"`
		Network   any        `toml:"network,omitempty"`
		Address   string     `toml:"address,omitempty"`
		Path      string     `toml:"path,omitempty"`
		Package   string     `toml:"package,omitempty"`
		Replay    *Replay    `toml:"replay,omitempty"`
		Calls     []Call     `toml:"call,omitempty"`
		Overrides []Override `toml:"override,omitempty"`
		Diff      *Diff      `toml:"diff,omitempty"`
	}{Version: f.Version, Address: f.Address, Path: f.Path, Package: f.Package, Calls: f.Calls, Overrides: f.Overrides}
	switch {
	case f.Network.RPCURL == "" && f.Network.Passphrase == "" && f.Network.Name != "":
		out.Network = f.Network.Name
	case f.Network != Network{}:
		out.Network = f.Network
	}
	if f.Replay != (Replay{}) {
		out.Replay = &f.Replay
	}
	if len(f.Diff.IgnoreEvents) > 0 || len(f.Diff.ResourceTolerance) > 0 {
		out.Diff = &f.Diff
	}
	var b strings.Builder
	if err := toml.NewEncoder(&b).Encode(out); err != nil {
		return nil, err
	}
	return []byte(b.String()), nil
}
