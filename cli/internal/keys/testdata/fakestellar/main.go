// Command fakestellar is a stand-in for the real `stellar` CLI, used only by
// keys_test.go and command regression tests. It understands the identity,
// version, and tx-sign invocations those tests make, with behavior selected by
// the requested name or FAKESTELLAR_* environment variables so tests do not
// need to build multiple binaries.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func main() {
	args := os.Args[1:]

	// `snapshot create ... --out <path>` (#554): copies FAKESTELLAR_SNAPSHOT
	// to --out, after failing as many times as the count in the file
	// FAKESTELLAR_SNAPSHOT_FAILURES names. FAKESTELLAR_ARGS_LOG, when set,
	// gets each invocation's arguments, one line each.
	if len(args) >= 2 && args[0] == "snapshot" && args[1] == "create" {
		snapshotCreate(args[2:])
		return
	}

	// `contract build --manifest-path <m> --package <p>` (#564), as
	// FAKESTELLAR_BUILD says: ok (the default) writes the WASM where cargo
	// would, fail prints rustc errors, stale succeeds without writing, slow
	// records its pid and a child's in FAKESTELLAR_PID_FILE and sleeps.
	if len(args) >= 2 && args[0] == "contract" && args[1] == "build" {
		contractBuild(args[2:])
		return
	}
	if len(args) == 1 && args[0] == "fake-sleep" {
		time.Sleep(30 * time.Second)
		return
	}

	// `tx sign --sign-with-key <name> --network-passphrase <p>`: signet always
	// passes the passphrase, so match on the prefix rather than the full arity.
	if len(args) >= 4 && args[0] == "tx" && args[1] == "sign" && args[2] == "--sign-with-key" {
		if detail := os.Getenv("FAKESTELLAR_SIGN_STDERR"); detail != "" {
			fmt.Fprintln(os.Stderr, detail)
			os.Exit(1)
		}
		if signed := os.Getenv("FAKESTELLAR_SIGN_STDOUT"); signed != "" {
			fmt.Println(signed)
			return
		}
		fmt.Fprintln(os.Stderr, "fakestellar: signing is not configured")
		os.Exit(2)
	}

	if len(args) == 2 && args[0] == "keys" && args[1] == "ls" {
		// Newline-separated identity names, as `stellar keys ls` prints them.
		// Empty (or unset) means a keystore with no identities at all.
		for _, name := range strings.Split(os.Getenv("FAKESTELLAR_IDENTITIES"), "\n") {
			if strings.TrimSpace(name) != "" {
				fmt.Println(strings.TrimSpace(name))
			}
		}
		return
	}

	if len(args) == 1 && args[0] == "--version" {
		version := os.Getenv("FAKESTELLAR_VERSION")
		if version == "" {
			version = "25.2.0"
		}
		fmt.Printf("stellar %s\n", version)
		return
	}

	if len(args) != 3 || args[0] != "keys" || args[1] != "address" {
		fmt.Fprintln(os.Stderr, "fakestellar: unsupported invocation")
		os.Exit(2)
	}
	if output := os.Getenv("FAKESTELLAR_ADDRESS_OUTPUT"); output != "" {
		fmt.Println(output)
		return
	}

	switch args[2] {
	case "alice":
		fmt.Println("GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD")
	case "bob":
		fmt.Println("GBVBJEP2BSKHW6YBFCZR2HJKHZDLJOU7ZKTH2HSNUUQY322RWLURH3EQ")
	case "garbage":
		fmt.Println("not-a-public-key")
	case "missing":
		fmt.Fprintln(os.Stderr, `no identity named "missing"`)
		os.Exit(1)
	default:
		fmt.Fprintln(os.Stderr, "fakestellar: unknown identity")
		os.Exit(1)
	}
}

func snapshotCreate(args []string) {
	if log := os.Getenv("FAKESTELLAR_ARGS_LOG"); log != "" {
		f, err := os.OpenFile(log, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err == nil {
			fmt.Fprintln(f, strings.Join(args, " "))
			_ = f.Close()
		}
	}
	out := ""
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--out" {
			out = args[i+1]
		}
	}
	fmt.Fprintln(os.Stderr, "ℹ️  Downloading history archive state")
	if counter := os.Getenv("FAKESTELLAR_SNAPSHOT_FAILURES"); counter != "" {
		raw, _ := os.ReadFile(counter)
		left, _ := strconv.Atoi(strings.TrimSpace(string(raw)))
		if left > 0 {
			_ = os.WriteFile(counter, []byte(strconv.Itoa(left-1)), 0o600)
			fmt.Fprintln(os.Stderr, "❌ error: downloading bucket: stream ended unexpectedly")
			os.Exit(1)
		}
	}
	raw, err := os.ReadFile(os.Getenv("FAKESTELLAR_SNAPSHOT"))
	if err != nil || out == "" {
		fmt.Fprintln(os.Stderr, "fakestellar: no snapshot configured")
		os.Exit(2)
	}
	if err := os.WriteFile(out, raw, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Fprintln(os.Stderr, "ℹ️  Saved 12 entries to "+out)
}

func contractBuild(args []string) {
	manifest, pkg := "", "contract"
	for i := 0; i+1 < len(args); i++ {
		switch args[i] {
		case "--manifest-path":
			manifest = args[i+1]
		case "--package":
			pkg = args[i+1]
		}
	}
	fmt.Fprintf(os.Stderr, "ℹ️  CARGO_BUILD_RUSTFLAGS=--cfg soroban_sdk_internal_no_rssdkver_meta cargo rustc --manifest-path=%s --crate-type=cdylib --target=wasm32v1-none --release\n", manifest)
	fmt.Fprintf(os.Stderr, "   Compiling %s v0.1.0\n", pkg)
	switch os.Getenv("FAKESTELLAR_BUILD") {
	case "fail":
		fmt.Fprint(os.Stderr, `error[E0425]: cannot find value `+"`x`"+` in this scope
  --> src/lib.rs:10:5
   |
10 |     x
   |     ^ not found in this scope

error[E0308]: mismatched types
  --> src/lib.rs:12:5

error: could not compile `+"`"+pkg+"`"+` (lib) due to 2 previous errors
`)
		os.Exit(101)
	case "stale":
		return
	case "slow":
		child := exec.Command(os.Args[0], "fake-sleep")
		_ = child.Start()
		pids := fmt.Sprintf("%d\n%d\n", os.Getpid(), child.Process.Pid)
		_ = os.WriteFile(os.Getenv("FAKESTELLAR_PID_FILE"), []byte(pids), 0o600)
		time.Sleep(30 * time.Second)
		return
	}
	out := filepath.Join(filepath.Dir(manifest), "target", "wasm32v1-none", "release", strings.ReplaceAll(pkg, "-", "_")+".wasm")
	_ = os.MkdirAll(filepath.Dir(out), 0o755)
	wasm := []byte("\x00asm\x01\x00\x00\x00")
	if src := os.Getenv("FAKESTELLAR_BUILD_WASM"); src != "" {
		if raw, err := os.ReadFile(src); err == nil {
			wasm = raw
		}
	}
	if err := os.WriteFile(out, wasm, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Fprintln(os.Stderr, "    Finished `release` profile [optimized] target(s) in 1.2s")
}
