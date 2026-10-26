package localnet

import (
	"bytes"
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

var fakeDir string

// TestMain builds testdata/fakebin once, as both `stellar` and `docker`.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "localnet-fakebin")
	if err != nil {
		panic(err)
	}
	exe := ""
	if runtime.GOOS == "windows" {
		exe = ".exe"
	}
	for _, name := range []string{"stellar", "docker"} {
		out, err := exec.Command("go", "build", "-o", filepath.Join(dir, name+exe), "./testdata/fakebin").CombinedOutput()
		if err != nil {
			panic(string(out))
		}
	}
	fakeDir = dir
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

type fake struct {
	t     *testing.T
	state string
	log   string
}

func newFake(t *testing.T) *fake {
	t.Helper()
	state := t.TempDir()
	f := &fake{t: t, state: state, log: filepath.Join(state, "log")}
	t.Setenv("FAKEBIN_DIR", state)
	t.Setenv("FAKEBIN_LOG", f.log)
	return f
}

func (f *fake) bin(name string) string {
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(fakeDir, name)
}

func (f *fake) calls() []string {
	raw, _ := os.ReadFile(f.log)
	return strings.Split(strings.TrimSpace(string(raw)), "\n")
}

func (f *fake) called(prefix string) []string {
	var out []string
	for _, c := range f.calls() {
		if strings.HasPrefix(c, prefix) {
			out = append(out, c)
		}
	}
	return out
}

func (f *fake) started() bool {
	_, err := os.Stat(filepath.Join(f.state, "started"))
	return err == nil
}

// options point at the fake binaries, with a probe that finds the local
// network once `stellar container start` has run (or always, when up).
func (f *fake) options(up bool, progress *[]string) Options {
	return Options{
		Stellar:  f.bin("stellar"),
		Docker:   f.bin("docker"),
		RPCURL:   "http://127.0.0.1:" + freePort(f.t) + "/rpc",
		Protocol: 28,
		Wait:     5 * time.Second,
		Poll:     10 * time.Millisecond,
		Probe: func(context.Context, string) (string, bool, error) {
			if up || f.started() {
				return Passphrase, true, nil
			}
			return "", false, errors.New("connection refused")
		},
		Progress: func(s string) {
			if progress != nil {
				*progress = append(*progress, s)
			}
		},
	}
}

func freePort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = l.Close() }()
	_, port, _ := net.SplitHostPort(l.Addr().String())
	return port
}

func TestStart_UsesARunningLocalNetwork(t *testing.T) {
	f := newFake(t)
	n, err := Start(context.Background(), f.options(true, nil))
	if err != nil {
		t.Fatal(err)
	}
	if n.Started {
		t.Fatal("started a network although one was running")
	}
	if len(f.called("docker")) != 0 || len(f.called("stellar container")) != 0 {
		t.Fatalf("touched Docker: %v", f.calls())
	}
	if len(f.called("stellar keys generate signet-dev --fund --network local")) != 1 {
		t.Fatalf("did not make and fund signet-dev: %v", f.calls())
	}
	if !accountRE.MatchString(n.Deployer) {
		t.Fatalf("deployer = %q", n.Deployer)
	}
}

func TestStart_StartsQuickstartAtTheForkProtocolWithLimits(t *testing.T) {
	f := newFake(t)
	o := f.options(false, nil)
	o.Protocol, o.Limits = 29, "unlimited"
	n, err := Start(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	if !n.Started {
		t.Fatal("Started is false")
	}
	if got := f.called("stellar container start"); len(got) != 1 || got[0] != "stellar container start local --protocol-version 29 --limits unlimited" {
		t.Fatalf("container start = %v", got)
	}
	if len(f.called("docker info")) != 1 {
		t.Fatalf("did not check Docker first: %v", f.calls())
	}
	// An identity that exists is funded again: the network is new.
	f2 := newFake(t)
	_ = os.WriteFile(filepath.Join(f2.state, "identities"), []byte("signet-dev\n"), 0o644)
	if _, err := Start(context.Background(), f2.options(true, nil)); err != nil {
		t.Fatal(err)
	}
	if len(f2.called("stellar keys fund signet-dev --network local")) != 1 || len(f2.called("stellar keys generate")) != 0 {
		t.Fatalf("calls = %v", f2.calls())
	}
}

func TestStart_SaysWhatIsWrong(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, f *fake, o *Options)
		want  string
	}{
		{"docker missing", func(_ *testing.T, _ *fake, o *Options) { o.Docker = "signet-no-such-docker" }, "docker is not installed"},
		{"docker not running", func(t *testing.T, _ *fake, _ *Options) { t.Setenv("FAKEBIN_DOCKER", "down") }, "needs Docker running, and it is not: Cannot connect to the Docker daemon"},
		{"port taken", func(t *testing.T, _ *fake, o *Options) {
			l, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = l.Close() })
			o.RPCURL = "http://" + l.Addr().String() + "/rpc"
		}, "is in use by something that is not a Stellar RPC"},
		{"another network", func(_ *testing.T, _ *fake, o *Options) {
			o.Probe = func(context.Context, string) (string, bool, error) {
				return "Test SDF Network ; September 2015", true, nil
			}
		}, `answers as a Stellar RPC for "Test SDF Network ; September 2015", not the local network`},
		{"never healthy", func(_ *testing.T, _ *fake, o *Options) {
			o.Wait = 50 * time.Millisecond
			o.Probe = func(context.Context, string) (string, bool, error) { return "", false, errors.New("refused") }
		}, "did not become healthy"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFake(t)
			o := f.options(false, nil)
			tc.setup(t, f, &o)
			_, err := Start(context.Background(), o)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to say %q", err, tc.want)
			}
			if tc.name != "never healthy" && !errors.Is(err, exitcode.ErrConfiguration) {
				t.Fatalf("err = %v, want a configuration error", err)
			}
		})
	}
}

func wasmFile(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "contract.wasm")
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func session(t *testing.T, f *fake, progress *[]string) *Session {
	t.Helper()
	n, err := Start(context.Background(), f.options(true, progress))
	if err != nil {
		t.Fatal(err)
	}
	return &Session{
		Net: n, Dir: filepath.Join(t.TempDir(), ".signet"),
		Now: func() time.Time { return time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC) },
	}
}

var upgradeable = Interface{
	Upgradeable: true,
	Functions: map[string][]Param{
		"upgrade": {{Name: "new_wasm_hash", Type: "bytes_n", N: 32}},
		"count":   nil,
	},
}

func TestDeploy_UpgradesInPlaceWhenTheContractCan(t *testing.T) {
	f := newFake(t)
	s := session(t, f, nil)
	first, err := s.Deploy(context.Background(), wasmFile(t, "v1"), upgradeable)
	if err != nil {
		t.Fatal(err)
	}
	v2 := wasmFile(t, "v2")
	second, err := s.Deploy(context.Background(), v2, upgradeable)
	if err != nil {
		t.Fatal(err)
	}
	if second.ContractID != first.ContractID {
		t.Fatalf("the address changed on an upgrade: %s -> %s", first.ContractID, second.ContractID)
	}
	hash, _ := WasmHash(v2)
	if second.WasmHash != hash {
		t.Fatalf("wasmHash = %s, want %s", second.WasmHash, hash)
	}
	calls := f.called("stellar contract")
	want := []string{
		"stellar contract deploy",
		"stellar contract upload --wasm " + v2,
		"stellar contract invoke --id " + first.ContractID + " --source signet-dev --network local --send yes -- upgrade --new_wasm_hash " + hash,
	}
	if len(calls) != 3 {
		t.Fatalf("contract calls = %v", calls)
	}
	for i, w := range want {
		if !strings.HasPrefix(calls[i], w) {
			t.Fatalf("call %d = %q, want it to start %q", i, calls[i], w)
		}
	}
	onDisk, err := ReadState(s.Dir)
	if err != nil || !reflect.DeepEqual(onDisk, second) {
		t.Fatalf("localnet.json = %+v (%v), want %+v", onDisk, err, second)
	}
}

func TestDeploy_DeploysFreshWhenItCannotUpgradeAndSaysTheAddressChanged(t *testing.T) {
	f := newFake(t)
	var progress []string
	s := session(t, f, &progress)
	fixed := Interface{Upgradeable: false, Functions: map[string][]Param{"count": nil}}
	first, err := s.Deploy(context.Background(), wasmFile(t, "v1"), fixed)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.Deploy(context.Background(), wasmFile(t, "v2"), fixed)
	if err != nil {
		t.Fatal(err)
	}
	if second.ContractID == first.ContractID {
		t.Fatal("the address did not change on a fresh deploy")
	}
	if len(f.called("stellar contract deploy")) != 2 || len(f.called("stellar contract upload")) != 0 {
		t.Fatalf("calls = %v", f.calls())
	}
	onDisk, _ := ReadState(s.Dir)
	if onDisk.ContractID != second.ContractID {
		t.Fatalf("localnet.json has %s, want %s", onDisk.ContractID, second.ContractID)
	}
	if !strings.Contains(strings.Join(progress, "\n"), "the address changed from "+first.ContractID+" to "+second.ContractID) {
		t.Fatalf("progress = %v", progress)
	}
	// An upgrade function without the code being able to replace itself is
	// not enough either.
	noSelf := upgradeable
	noSelf.Upgradeable = false
	if _, err := s.Deploy(context.Background(), wasmFile(t, "v3"), noSelf); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Deploy(context.Background(), wasmFile(t, "v4"), noSelf); err != nil {
		t.Fatal(err)
	}
	if len(f.called("stellar contract upload")) != 0 {
		t.Fatalf("upgraded code that cannot replace itself: %v", f.calls())
	}
}

func TestWriteState_IsAtomic(t *testing.T) {
	dir := t.TempDir()
	if err := WriteState(dir, State{ContractID: "C1"}); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		// A reader holding the old file keeps reading the old file: the new
		// one replaced it by a rename, not by writing into it.
		old, err := os.Open(filepath.Join(dir, StateFile))
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = old.Close() }()
		if err := WriteState(dir, State{ContractID: "C2"}); err != nil {
			t.Fatal(err)
		}
		var b bytes.Buffer
		_, _ = b.ReadFrom(old)
		if !strings.Contains(b.String(), `"C1"`) {
			t.Fatalf("the old file was written in place: %s", b.String())
		}
	}
	got, err := ReadState(dir)
	if err != nil || (runtime.GOOS != "windows" && got.ContractID != "C2") {
		t.Fatalf("state = %+v, %v", got, err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("left behind: %v", entries)
	}
}

func TestDeploy_WritesBindingsWhenAsked(t *testing.T) {
	f := newFake(t)
	s := session(t, f, nil)
	s.Bindings = filepath.Join(t.TempDir(), "bindings")
	st, err := s.Deploy(context.Background(), wasmFile(t, "v1"), Interface{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(s.Bindings, "index.ts")); err != nil {
		t.Fatalf("no bindings: %v (calls %v)", err, f.calls())
	}
	if got := f.called("stellar contract bindings typescript"); len(got) != 1 || !strings.Contains(got[0], "--contract-id "+st.ContractID) {
		t.Fatalf("bindings call = %v", got)
	}
}

func TestSeed_RunsTheCallsInOrderWithAddressesMapped(t *testing.T) {
	f := newFake(t)
	s := session(t, f, nil)
	const forkContract = "CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN"
	alice := "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
	bob := "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
	var report bytes.Buffer
	s.ForkContract, s.Out = forkContract, &report
	s.Seed = []SeedCall{
		{Name: "alice claims", Function: "claim", Args: map[string]any{"handle": "alice", "wallet": alice}},
		{Name: "bob claims", Function: "claim", Args: map[string]any{"handle": "bob", "wallet": bob}},
		{Name: "alice again", Function: "touch", Args: map[string]any{"who": []any{alice, forkContract}, "n": int64(3)}},
	}
	registry := Interface{Functions: map[string][]Param{"initialize": {{Name: "admin", Type: "address"}}}}
	st, err := s.Deploy(context.Background(), wasmFile(t, "registry"), registry)
	if err != nil {
		t.Fatal(err)
	}
	invokes := f.called("stellar contract invoke")
	if len(invokes) != 4 {
		t.Fatalf("invokes = %v", invokes)
	}
	if !strings.HasSuffix(invokes[0], "-- initialize --admin "+s.Net.Deployer) {
		t.Fatalf("initialize first, with signet-dev as admin: %q", invokes[0])
	}
	seed1, seed2 := st.SeedAccounts[alice], st.SeedAccounts[bob]
	if seed1.Identity != "seed-1" || seed2.Identity != "seed-2" || seed1.Address == alice {
		t.Fatalf("seedAccounts = %+v", st.SeedAccounts)
	}
	if !strings.HasSuffix(invokes[1], "-- claim --handle alice --wallet "+seed1.Address) ||
		!strings.HasSuffix(invokes[2], "-- claim --handle bob --wallet "+seed2.Address) {
		t.Fatalf("seed calls = %v", invokes[1:3])
	}
	wantTouch := `-- touch --n 3 --who ["` + seed1.Address + `","` + st.ContractID + `"]`
	if !strings.HasSuffix(invokes[3], wantTouch) {
		t.Fatalf("nested mapping: %q, want suffix %q", invokes[3], wantTouch)
	}
	text := report.String()
	if !strings.Contains(text, "localnet's is "+st.ContractID+", the fork's "+forkContract) {
		t.Fatalf("report lacks the address line:\n%s", text)
	}
	for _, line := range NotSeededLines {
		if !strings.Contains(text, "  - "+line+"\n") {
			t.Fatalf("report lacks %q:\n%s", line, text)
		}
	}
	onDisk, _ := ReadState(s.Dir)
	if onDisk.SeedAccounts[alice] != seed1 {
		t.Fatalf("localnet.json seedAccounts = %+v", onDisk.SeedAccounts)
	}
}

func TestSeed_AFailingCallStopsAndSaysWhich(t *testing.T) {
	f := newFake(t)
	s := session(t, f, nil)
	t.Setenv("FAKEBIN_INVOKE_FAIL", "claim")
	s.Seed = []SeedCall{{Name: "alice claims", Function: "claim", Args: map[string]any{"handle": "alice"}}}
	_, err := s.Deploy(context.Background(), wasmFile(t, "v1"), Interface{})
	if err == nil || !strings.Contains(err.Error(), "seed call alice claims") {
		t.Fatalf("err = %v", err)
	}
}

func TestConstructorTakesSignetDevAsAdmin(t *testing.T) {
	f := newFake(t)
	s := session(t, f, nil)
	iface := Interface{Functions: map[string][]Param{"__constructor": {{Name: "owner", Type: "address"}}}}
	if _, err := s.Deploy(context.Background(), wasmFile(t, "v1"), iface); err != nil {
		t.Fatal(err)
	}
	deploys := f.called("stellar contract deploy")
	if len(deploys) != 1 || !strings.HasSuffix(deploys[0], "-- --owner "+s.Net.Deployer) {
		t.Fatalf("deploy = %v", deploys)
	}
}

// docs/SANDBOX.md quotes the not-seeded report verbatim (#590).
func TestTheNotSeededReportIsQuotedInTheGuide(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "SANDBOX.md"))
	if err != nil {
		t.Fatal(err)
	}
	// A Windows checkout may have CRLF line endings.
	guide := strings.ReplaceAll(string(raw), "\r\n", "\n")
	for _, line := range NotSeededLines {
		if !strings.Contains(guide, "  - "+line+"\n") {
			t.Fatalf("docs/SANDBOX.md does not quote %q", line)
		}
	}
	if !strings.Contains(guide, "(a contract ID derives from the network and the deployer)") {
		t.Fatal("docs/SANDBOX.md lacks the address line")
	}
}
