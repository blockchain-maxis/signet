package cmd

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/fork"
)

// fakeStellar builds internal/keys' fake stellar CLI, answering `snapshot
// create` with the registry snapshot fixture, and returns its path.
func fakeStellar(t *testing.T) string {
	t.Helper()
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skipf("go binary not found: %v", err)
	}
	name := "stellar"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	out := filepath.Join(t.TempDir(), name)
	build := exec.Command(goBin, "build", "-o", out, "../keys/testdata/fakestellar")
	build.Env = append(os.Environ(), goToolEnv...)
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("building fakestellar: %v\n%s", err, output)
	}
	snapshot, _ := filepath.Abs(filepath.Join("..", "rpc", "testdata", "registry", "snapshot.json"))
	t.Setenv("FAKESTELLAR_SNAPSHOT", snapshot)
	return out
}

func TestSandboxForkArchiveImportsAConsistentSnapshot(t *testing.T) {
	e := newCallEnv(t)
	e.stellar = fakeStellar(t)
	log := filepath.Join(t.TempDir(), "args.log")
	t.Setenv("FAKESTELLAR_ARGS_LOG", log)

	stdout, stderr, err := e.sandbox("fork", "--rpc-url", e.rpc.srv.URL, registryContract, "--archive", "--ledger", "4886975", "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, stderr)
	}
	var m fork.Manifest
	if err := json.Unmarshal([]byte(stdout[strings.Index(stdout, "{"):]), &m); err != nil {
		t.Fatalf("%v\n%s", err, stdout)
	}
	if !m.Consistent || m.ForkLedger != registryLedger || m.Executable != "wasm" || m.InstanceStorageEntries != 2 {
		t.Fatalf("manifest = %+v", m)
	}
	args, _ := os.ReadFile(log)
	for _, want := range []string{"--address " + registryContract, "--output json", "--ledger 4886975", "--network-passphrase Test SDF Network ; September 2015"} {
		if !strings.Contains(string(args), want) {
			t.Errorf("stellar was not asked %q: %s", want, args)
		}
	}
	// Everything came from the snapshot: no entry was asked of RPC.
	if len(e.rpc.asked) != 0 {
		t.Fatalf("fetched from RPC: %v", e.rpc.asked)
	}

	stdout, stderr, err = e.sandbox("state", registryContract+"@4887004")
	if err != nil {
		t.Fatalf("%v\n%s", err, stderr)
	}
	for _, want := range []string{"complete storage, from a history-archive snapshot (2 entries)", `instance   ["Admin"] = "GC6Y`, `instance   ["Count"] = 2`} {
		if !strings.Contains(stdout, want) {
			t.Errorf("state lacks %q:\n%s", want, stdout)
		}
	}
	if strings.Contains(stdout, "not the full storage") {
		t.Fatalf("a consistent fork is complete:\n%s", stdout)
	}
	// And a call runs on it.
	if res := e.json(registryContract, "count"); string(res.ReturnValue) != "2" {
		t.Fatalf("count = %s", res.ReturnValue)
	}
}

func TestSandboxStateSaysALazyForkIsNotTheFullStorage(t *testing.T) {
	e := newCallEnv(t)
	if _, stderr, err := e.sandbox("fork", "--rpc-url", e.rpc.srv.URL, registryContract); err != nil {
		t.Fatalf("%v\n%s", err, stderr)
	}
	stdout, _, err := e.sandbox("state", registryContract+"@4887004")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout, "known keys (2) — this is not the full storage") || !strings.Contains(stdout, "--archive takes it all") {
		t.Fatalf("stdout:\n%s", stdout)
	}
	var res StateResult
	stdout, _, _ = e.sandbox("state", registryContract+"@4887004", "--json")
	if err := json.Unmarshal([]byte(stdout), &res); err != nil || res.Complete || len(res.Entries) != 2 {
		t.Fatalf("--json: %+v %v\n%s", res, err, stdout)
	}
	if _, _, err := e.sandbox("state", "nope@1"); ExitCode(err) != exitcode.InvalidInput {
		t.Fatalf("unknown fork: %v", err)
	}
}

func TestSandboxForkArchiveRetriesOnceThenPointsAtTheLazyFork(t *testing.T) {
	e := newCallEnv(t)
	e.stellar = fakeStellar(t)
	failures := filepath.Join(t.TempDir(), "failures")
	t.Setenv("FAKESTELLAR_SNAPSHOT_FAILURES", failures)

	// One failure: retried, and the fork is made.
	_ = os.WriteFile(failures, []byte("1"), 0o600)
	stdout, stderr, err := e.sandbox("fork", "--rpc-url", e.rpc.srv.URL, registryContract, "--archive")
	if err != nil {
		t.Fatalf("%v\n%s%s", err, stdout, stderr)
	}
	if !strings.Contains(stdout+stderr, "trying once more") || !strings.Contains(stdout+stderr, "stellar: ❌ error: downloading bucket") {
		t.Fatalf("output:\n%s%s", stdout, stderr)
	}

	// Two: it gives up with stellar's error and the way out.
	forks, _ := fork.List(e.root)
	_ = fork.Remove(forks[0])
	_ = os.WriteFile(failures, []byte("2"), 0o600)
	_, _, err = e.sandbox("fork", "--rpc-url", e.rpc.srv.URL, registryContract, "--archive")
	if ExitCode(err) != exitcode.Network || !strings.Contains(err.Error(), "stream ended unexpectedly") || !strings.Contains(err.Error(), "without --archive") {
		t.Fatalf("exit %d: %v", ExitCode(err), err)
	}

	if _, _, err := e.sandbox("fork", "--rpc-url", e.rpc.srv.URL, registryContract, "--ledger", "5"); ExitCode(err) != exitcode.InvalidInput {
		t.Fatalf("--ledger alone: %v", err)
	}
}
