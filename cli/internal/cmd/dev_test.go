package cmd

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// devTools builds fake stellar, cargo and rustup into one directory and
// makes it the whole PATH, so a test can take any of them away.
func devTools(t *testing.T) string {
	t.Helper()
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skipf("go binary not found: %v", err)
	}
	dir := t.TempDir()
	exe := func(name string) string {
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		return filepath.Join(dir, name)
	}
	for out, pkg := range map[string]string{
		exe("stellar"): "../keys/testdata/fakestellar",
		exe("cargo"):   "../dev/testdata/fakedevtools",
		exe("rustup"):  "../dev/testdata/fakedevtools",
	} {
		build := exec.Command(goBin, "build", "-o", out, pkg)
		build.Env = append(os.Environ(), goToolEnv...)
		if output, err := build.CombinedOutput(); err != nil {
			t.Fatalf("building %s: %v\n%s", pkg, err, output)
		}
	}
	t.Setenv("PATH", dir)
	return dir
}

// devCrate is a crate directory with a Cargo.toml (fake cargo reads none).
func devCrate(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Cargo.toml"), []byte("[package]\nname = \"identity-registry\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestDevPreflightNamesEachMissingPiece(t *testing.T) {
	e := newCallEnv(t)
	tools := devTools(t)
	e.stellar = "stellar"
	crate := devCrate(t)
	run := func(extra ...string) error {
		_, _, err := e.cli(append([]string{"dev", registryContract, "--path", crate, "--rpc-url", e.rpc.srv.URL}, extra...)...)
		return err
	}
	exe := func(name string) string {
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		return filepath.Join(tools, name)
	}
	hide := func(name string) func() {
		_ = os.Rename(exe(name), exe(name)+".away")
		return func() { _ = os.Rename(exe(name)+".away", exe(name)) }
	}
	expect := func(step string, err error, code int, want string) {
		t.Helper()
		if ExitCode(err) != code || err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: exit %d, %v; want %d and %q", step, ExitCode(err), err, code, want)
		}
	}

	restore := hide("stellar")
	expect("stellar", run(), exitcode.Configuration, "stellar")
	restore()

	restore = hide("cargo")
	expect("cargo", run(), exitcode.Configuration, "cargo is not on PATH")
	restore()

	t.Setenv("FAKERUSTUP_TARGETS", "x86_64-unknown-linux-gnu")
	expect("target", run(), exitcode.Configuration, "rustup target add wasm32v1-none")
	t.Setenv("FAKERUSTUP_TARGETS", "")

	_, _, err := e.cli("dev", registryContract, "--path", t.TempDir(), "--rpc-url", e.rpc.srv.URL)
	expect("Cargo.toml", err, exitcode.Configuration, "has no Cargo.toml")
	t.Setenv("FAKECARGO_NO_CDYLIB", "1")
	expect("cdylib", run(), exitcode.Configuration, "no cdylib crate")
	t.Setenv("FAKECARGO_NO_CDYLIB", "")
	expect("package", run("--package", "other"), exitcode.Configuration, `no contract crate "other"`)

	sim := e.sim
	e.sim = ""
	expect("simulator", run(), exitcode.Configuration, "simulator not found")
	e.sim = sim

	e.rpc.mu.Lock()
	e.rpc.override["getLatestLedger"] = map[string]any{"id": "x", "protocolVersion": 99, "sequence": 4887004}
	e.rpc.mu.Unlock()
	expect("lane", run(), exitcode.HostUnsupported, "99")
	e.rpc.mu.Lock()
	delete(e.rpc.override, "getLatestLedger")
	e.rpc.mu.Unlock()

	stdout, stderr, err := e.cli("dev", registryContract, "--path", crate, "--rpc-url", e.rpc.srv.URL, "--ci")
	if err != nil {
		t.Fatalf("%v\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "signet dev · CASF…RCN @ testnet ledger 4887004 · lane p28 · crate identity-registry") ||
		!strings.Contains(stdout, "built identity_registry.wasm in") {
		t.Fatalf("header and build:\n%s", stdout)
	}

	// A compile error, shown trimmed: with --ci it exits 12.
	t.Setenv("FAKESTELLAR_BUILD", "fail")
	expect("--ci", run("--ci"), exitcode.BuildFailed, "error[E0425]")
}

func TestDevTakesWhatTheFlagsLeaveOutFromSignetDevToml(t *testing.T) {
	e := newCallEnv(t)
	devTools(t)
	e.stellar = "stellar"
	crate := devCrate(t)
	dir := t.TempDir()
	toml := "version = 1\naddress = \"" + registryContract + "\"\npath = \"" + filepath.ToSlash(crate) + "\"\n" +
		"\n[[call]]\nname = \"count is stable\"\nfunction = \"count\"\nargs = {}\nexpect = \"unchanged\"\n" +
		// An override the calls do not read: applied in the session (#567).
		"\n[[override]]\ndurability = \"persistent\"\nkey = '\"note\"'\nvalue = 'true'\n"
	if err := os.WriteFile(filepath.Join(dir, "signet.dev.toml"), []byte(toml), 0o644); err != nil {
		t.Fatal(err)
	}
	// The build is the registry's own WASM, so A and B agree (#566).
	registryWasm, _ := filepath.Abs(filepath.Join("..", "..", "..", "packages", "spec", "fixtures", "identity-registry.wasm"))
	t.Setenv("FAKESTELLAR_BUILD_WASM", registryWasm)
	t.Chdir(dir)
	stdout, stderr, err := e.cli("dev", "--rpc-url", e.rpc.srv.URL, "--ci")
	if err != nil {
		t.Fatalf("%v\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "crate identity-registry") ||
		!strings.Contains(stdout, "replayed 1 saved call on 936996c7 (deployed) and 936996c7 (build): 2 runs") ||
		!strings.Contains(stdout, "count is stable  A 2  =  B 2  ✓ unchanged") {
		t.Fatalf("stdout:\n%s", stdout)
	}
	t.Chdir(t.TempDir())
	if _, _, err := e.cli("dev", "--rpc-url", e.rpc.srv.URL, "--ci"); ExitCode(err) != exitcode.InvalidInput {
		t.Fatalf("no contract anywhere: %v", err)
	}
}
