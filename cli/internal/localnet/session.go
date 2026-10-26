package localnet

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

// Param is one input of a contract function, as its spec declares it.
type Param struct {
	Name string
	// Type is the spec's type name: "address", "bytes_n", "u32", …
	Type string
	// N is bytes_n's length.
	N int
}

// Interface is what a deploy needs to know about a build: whether the
// deployed code can replace itself, and its constructor and initializer.
type Interface struct {
	// Upgradeable is wasm_inspect's verdict that the code can replace its
	// own executable (#540).
	Upgradeable bool
	// Functions are the spec's functions by name, with their inputs.
	Functions map[string][]Param
}

// upgradeArg is the name of `upgrade`'s one BytesN<32> input, or "" when
// the contract cannot be upgraded in place that way.
func (i *Interface) upgradeArg() string {
	if i == nil || !i.Upgradeable {
		return ""
	}
	in, ok := i.Functions["upgrade"]
	if !ok || len(in) != 1 || in[0].Type != "bytes_n" || in[0].N != 32 {
		return ""
	}
	return in[0].Name
}

// adminOnly is the name of fn's single Address input, when that is its
// only input: a constructor or initializer signet-dev can satisfy as admin.
func (i *Interface) adminOnly(fn string) (string, bool) {
	in, ok := i.Functions[fn]
	if !ok || len(in) != 1 || in[0].Type != "address" {
		return "", false
	}
	return in[0].Name, true
}

// SeedCall is a `[[call]]` marked `seed = true`: run as a real transaction
// on localnet after a fresh deploy (#590).
type SeedCall struct {
	Name     string
	Function string
	Args     map[string]any
}

// Session keeps the localnet contract in step with the build (#589).
type Session struct {
	Net *Net
	// Dir is where localnet.json goes (`.signet/` in the project).
	Dir string
	// Bindings, when set, gets TypeScript bindings after each deploy.
	Bindings string
	// ForkContract is the contract's address on the fork; seed arguments
	// naming it are mapped to the localnet contract.
	ForkContract string
	// Seed are the calls to replay on a fresh deploy; nil without
	// --localnet-seed.
	Seed []SeedCall
	// Out gets the not-seeded report.
	Out io.Writer
	// Now is the clock (tests fix it).
	Now func() time.Time

	state    State
	deployed *Interface
}

// State is the last deploy's.
func (s *Session) State() State { return s.state }

// Deploy brings localnet to the build at wasm: upgraded in place, keeping
// its storage, when the deployed code exposes upgrade(BytesN<32>) and can
// replace itself; otherwise deployed fresh, initialized and seeded, with the
// address change said. localnet.json is rewritten either way.
func (s *Session) Deploy(ctx context.Context, wasm string, iface Interface) (State, error) {
	progress := s.Net.o.Progress
	hash, err := WasmHash(wasm)
	if err != nil {
		return s.state, err
	}
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	previous := s.state.ContractID
	if arg := s.deployed.upgradeArg(); previous != "" && arg != "" {
		uploaded, err := s.Net.Upload(ctx, wasm)
		if err != nil {
			return s.state, err
		}
		if _, err := s.Net.Invoke(ctx, previous, Identity, "upgrade", []string{"--" + arg, uploaded}); err != nil {
			return s.state, err
		}
		s.state.WasmHash, s.state.DeployedAt = hash, now().UTC().Format(time.RFC3339)
		progress(fmt.Sprintf("localnet: upgraded %s in place to %s (storage kept)", previous, short(hash)))
	} else {
		var constructor []string
		if name, ok := iface.adminOnly("__constructor"); ok {
			constructor = []string{"--" + name, s.Net.Deployer}
		}
		id, err := s.Net.Deploy(ctx, wasm, constructor)
		if err != nil {
			return s.state, err
		}
		s.state = State{
			ContractID: id, RPCURL: s.Net.RPCURL(), NetworkPassphrase: Passphrase,
			WasmHash: hash, DeployedAt: now().UTC().Format(time.RFC3339),
		}
		if previous != "" {
			progress(fmt.Sprintf("localnet: the deployed contract cannot upgrade itself in place, so this build was deployed fresh: the address changed from %s to %s", previous, id))
		}
		if name, ok := iface.adminOnly("initialize"); ok {
			if _, err := s.Net.Invoke(ctx, id, Identity, "initialize", []string{"--" + name, s.Net.Deployer}); err != nil {
				return s.state, err
			}
			progress(fmt.Sprintf("localnet: initialize(%s = %s)", name, Identity))
		}
		if s.Seed != nil {
			if err := s.seed(ctx); err != nil {
				return s.state, err
			}
		}
	}
	s.deployed = &iface
	if err := WriteState(s.Dir, s.state); err != nil {
		return s.state, err
	}
	if s.Bindings != "" {
		if err := s.Net.Bindings(ctx, wasm, s.state.ContractID, s.Bindings); err != nil {
			progress("localnet: bindings failed: " + err.Error())
		}
	}
	progress(fmt.Sprintf("localnet: %s · rpc %s · passphrase %s", s.state.ContractID, s.state.RPCURL, s.state.NetworkPassphrase))
	return s.state, nil
}

// seed runs the seed calls in order as real transactions, each fork account
// in their arguments replaced by a funded localnet identity, then prints
// what could not be seeded.
func (s *Session) seed(ctx context.Context) error {
	accounts := map[string]SeedAccount{}
	var mapErr error
	mapValue := func(v string) string {
		switch {
		case v == s.ForkContract && s.ForkContract != "":
			return s.state.ContractID
		case accountRE.MatchString(v):
			if a, ok := accounts[v]; ok {
				return a.Address
			}
			name := fmt.Sprintf("seed-%d", len(accounts)+1)
			addr, err := s.Net.Fund(ctx, name)
			if err != nil && mapErr == nil {
				mapErr = err
			}
			accounts[v] = SeedAccount{Identity: name, Address: addr}
			return addr
		}
		return v
	}
	for _, call := range s.Seed {
		var args []string
		for _, name := range sortedKeys(call.Args) {
			args = append(args, "--"+name, argString(mapArg(call.Args[name], mapValue)))
		}
		if mapErr != nil {
			return mapErr
		}
		if _, err := s.Net.Invoke(ctx, s.state.ContractID, Identity, call.Function, args); err != nil {
			return fmt.Errorf("seed call %s: %w", call.Name, err)
		}
		s.Net.o.Progress(fmt.Sprintf("localnet: seeded %s (%s)", call.Name, call.Function))
	}
	if len(accounts) > 0 {
		s.state.SeedAccounts = accounts
	}
	if s.Out != nil {
		_, _ = io.WriteString(s.Out, NotSeededReport(s.state.ContractID, s.ForkContract, len(s.Seed)))
	}
	return nil
}

// mapArg maps every string in an argument value, however nested.
func mapArg(v any, f func(string) string) any {
	switch t := v.(type) {
	case string:
		return f(t)
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = mapArg(e, f)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, e := range t {
			out[k] = mapArg(e, f)
		}
		return out
	}
	return v
}

// argString is how `stellar contract invoke` takes an argument: strings as
// they are, everything else as JSON.
func argString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case int64:
		return strconv.FormatInt(t, 10)
	case int:
		return strconv.Itoa(t)
	}
	raw, _ := json.Marshal(v)
	return string(raw)
}

// The not-seeded report's lines: what seeding by real transactions cannot
// recreate. docs/SANDBOX.md quotes them verbatim (a test checks).
var NotSeededLines = []string{
	"other accounts' balances and trustlines, and other contracts' state",
	"entries only an admin you don't control could have written",
	"historical timestamps and TTLs: localnet starts at genesis, at the current time",
	"anything written by transactions that are not in the seed list",
}

// NotSeededReport is printed after every seeding: localnet is not a copy of
// the fork, and says how not.
func NotSeededReport(localContract, forkContract string, seedCalls int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "localnet: seeded by %d real %s; not seeded from the fork:\n", seedCalls, plural(seedCalls, "transaction", "transactions"))
	fmt.Fprintf(&b, "  - the contract's address: localnet's is %s, the fork's %s (a contract ID derives from the network and the deployer)\n", localContract, forkContract)
	for _, line := range NotSeededLines {
		fmt.Fprintf(&b, "  - %s\n", line)
	}
	return b.String()
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

func short(hash string) string {
	if len(hash) > 12 {
		return hash[:12] + "…"
	}
	return hash
}

// ReadState reads dir/localnet.json, if there is one.
func ReadState(dir string) (State, error) {
	var s State
	raw, err := os.ReadFile(dir + string(os.PathSeparator) + StateFile)
	if err != nil {
		return s, err
	}
	return s, json.Unmarshal(raw, &s)
}
