package cmd

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/visualise"
)

// #578: the registry drawn by the CLI is the Node golden, byte for byte.
func TestVisualiseDrawsTheRegistryAsTheVisualiserDoes(t *testing.T) {
	e := newCallEnv(t)
	wasm, _ := filepath.Abs(filepath.Join("..", "..", "..", "packages", "spec", "fixtures", "identity-registry.wasm"))
	golden, _ := filepath.Abs(filepath.Join("..", "..", "..", "packages", "visualiser", "fixtures", "__golden__", "standalone", "identity-registry.svg"))
	out := filepath.Join(t.TempDir(), "registry.svg")
	if _, stderr, err := e.cli("visualise", registryContract, "--wasm", wasm, "--out", out); err != nil {
		t.Fatalf("%v\n%s", err, stderr)
	}
	got, _ := os.ReadFile(out)
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		at := 0
		for at < len(got) && at < len(want) && got[at] == want[at] {
			at++
		}
		t.Fatalf("the SVG differs from %s at byte %d:\n  golden: %q\n  got:    %q", golden, at,
			string(want[at:min(at+80, len(want))]), string(got[at:min(at+80, len(got))]))
	}

	// A bundle that runs too long is stopped with a clear error.
	defer func(old time.Duration) { visualise.Limit = old }(visualise.Limit)
	visualise.Limit = time.Nanosecond
	_, _, err = e.cli("visualise", registryContract, "--wasm", wasm, "--out", out)
	if ExitCode(err) != exitcode.Timeout || !strings.Contains(err.Error(), "time limit") {
		t.Fatalf("timeout: %v", err)
	}
}

func TestVisualiseNamesWhatIsMissing(t *testing.T) {
	e := newCallEnv(t)
	tools := devTools(t)
	e.stellar = "stellar"
	exe := filepath.Join(tools, "stellar")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	// No stellar CLI to fetch the WASM with: a configuration error.
	_ = os.Rename(exe, exe+".away")
	if _, _, err := e.cli("visualise", registryContract); ExitCode(err) != exitcode.Configuration || !strings.Contains(err.Error(), "stellar") {
		t.Fatalf("no stellar: %v", err)
	}
	// No simulator: #527's message.
	wasm, _ := filepath.Abs(filepath.Join("..", "..", "..", "packages", "spec", "fixtures", "identity-registry.wasm"))
	e.sim = ""
	if _, _, err := e.cli("visualise", registryContract, "--wasm", wasm); ExitCode(err) != exitcode.Configuration || !strings.Contains(err.Error(), "simulator not found") {
		t.Fatalf("no simulator: %v", err)
	}
}

func TestVisualiseRefusesAWasmWithoutASpec(t *testing.T) {
	e := newCallEnv(t)
	noSpec, _ := filepath.Abs(filepath.Join("..", "..", "..", "packages", "spec", "fixtures", "no_spec.wasm"))
	if _, _, err := e.cli("visualise", registryContract, "--wasm", noSpec, "--out", filepath.Join(t.TempDir(), "x.svg")); ExitCode(err) != exitcode.NoSpec {
		t.Fatalf("no spec: exit %d, %v", ExitCode(err), err)
	}
	// --open with no session says how to start one.
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	if _, _, err := e.cli("visualise", registryContract, "--open"); err == nil || !strings.Contains(err.Error(), "signet dev "+registryContract+" --ui") {
		t.Fatalf("--open: %v", err)
	}
}

func TestVisualiseNetworkAndRPC(t *testing.T) {
	wasm, _ := filepath.Abs(filepath.Join("..", "..", "..", "packages", "spec", "fixtures", "identity-registry.wasm"))

	t.Run("mainnet env uses mainnet", func(t *testing.T) {
		e := newCallEnv(t)
		e.stellar = fakeStellar(t)
		t.Setenv("FAKESTELLAR_FETCH_WASM", wasm)
		t.Setenv("SIGNET_NETWORK", "mainnet")
		log := filepath.Join(t.TempDir(), "args.log")
		t.Setenv("FAKESTELLAR_ARGS_LOG", log)

		out := filepath.Join(t.TempDir(), "out.svg")
		if _, stderr, err := e.cli("visualise", registryContract, "--out", out); err != nil {
			t.Fatalf("%v\n%s", err, stderr)
		}
		raw, err := os.ReadFile(log)
		if err != nil {
			t.Fatal(err)
		}
		args := strings.TrimSpace(string(raw))
		if !strings.Contains(args, "--network mainnet") {
			t.Fatalf("expected --network mainnet in args, got: %s", args)
		}
	})

	t.Run("context rpcUrl passes rpc-url and passphrase", func(t *testing.T) {
		e := newCallEnv(t)
		e.stellar = fakeStellar(t)
		t.Setenv("FAKESTELLAR_FETCH_WASM", wasm)
		log := filepath.Join(t.TempDir(), "args.log")
		t.Setenv("FAKESTELLAR_ARGS_LOG", log)

		if _, stderr, err := e.cli("config", "set", "rpc-url", "https://context-rpc.example"); err != nil {
			t.Fatalf("config set rpc-url: %v\n%s", err, stderr)
		}

		out := filepath.Join(t.TempDir(), "out.svg")
		if _, stderr, err := e.cli("visualise", registryContract, "--out", out); err != nil {
			t.Fatalf("%v\n%s", err, stderr)
		}
		raw, err := os.ReadFile(log)
		if err != nil {
			t.Fatal(err)
		}
		args := strings.TrimSpace(string(raw))
		if !strings.Contains(args, "--rpc-url https://context-rpc.example") {
			t.Fatalf("expected --rpc-url in args, got: %s", args)
		}
		if !strings.Contains(args, "--network-passphrase") {
			t.Fatalf("expected --network-passphrase in args, got: %s", args)
		}
	})

	t.Run("futurenet with rpc-url is accepted", func(t *testing.T) {
		e := newCallEnv(t)
		e.stellar = fakeStellar(t)
		t.Setenv("FAKESTELLAR_FETCH_WASM", wasm)
		log := filepath.Join(t.TempDir(), "args.log")
		t.Setenv("FAKESTELLAR_ARGS_LOG", log)

		out := filepath.Join(t.TempDir(), "out.svg")
		if _, stderr, err := e.cli("visualise", registryContract, "--network", "futurenet", "--rpc-url", "https://futurenet.example", "--out", out); err != nil {
			t.Fatalf("%v\n%s", err, stderr)
		}
		raw, err := os.ReadFile(log)
		if err != nil {
			t.Fatal(err)
		}
		args := strings.TrimSpace(string(raw))
		if !strings.Contains(args, "--rpc-url https://futurenet.example") {
			t.Fatalf("expected --rpc-url in args, got: %s", args)
		}
		if !strings.Contains(args, "Test SDF Future Network") {
			t.Fatalf("expected futurenet passphrase in args, got: %s", args)
		}
	})
}
