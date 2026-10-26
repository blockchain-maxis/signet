// Command fakebin stands in for both `stellar` and `docker` in the localnet
// tests, by the name it is run as. Every invocation is appended to
// $FAKEBIN_LOG as one line, "<name> <args…>"; its state (identities, deploy
// count, the started container) lives in files under $FAKEBIN_DIR.
package main

import (
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func main() {
	name := strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe")
	args := os.Args[1:]
	logf(name + " " + strings.Join(args, " "))
	if name == "docker" {
		if os.Getenv("FAKEBIN_DOCKER") == "down" {
			fmt.Fprintln(os.Stderr, "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?")
			os.Exit(1)
		}
		fmt.Println("27.0.1")
		return
	}
	stellar(args)
}

func logf(line string) {
	f, err := os.OpenFile(os.Getenv("FAKEBIN_LOG"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintln(f, line)
}

func state(file string) string { return filepath.Join(os.Getenv("FAKEBIN_DIR"), file) }

func has(list, item string) bool {
	raw, _ := os.ReadFile(state(list))
	for _, l := range strings.Split(string(raw), "\n") {
		if l == item {
			return true
		}
	}
	return false
}

func add(list, item string) {
	f, _ := os.OpenFile(state(list), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	defer f.Close()
	fmt.Fprintln(f, item)
}

// address is a deterministic G… for an identity.
func address(name string) string {
	a, b := sha256.Sum256([]byte(name)), sha256.Sum256([]byte(name+"."))
	return ("G" + base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(append(a[:], b[:]...)))[:56]
}

func fail(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	os.Exit(1)
}

func flag(args []string, name string) string {
	for i, a := range args {
		if a == name && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func stellar(args []string) {
	switch {
	case len(args) >= 3 && args[0] == "keys" && args[1] == "address":
		if !has("identities", args[2]) {
			fail("error: Failed to find config identity for " + args[2])
		}
		fmt.Println(address(args[2]))
	case len(args) >= 3 && args[0] == "keys" && args[1] == "generate":
		add("identities", args[2])
	case len(args) >= 3 && args[0] == "keys" && args[1] == "fund":
	case len(args) >= 2 && args[0] == "container" && args[1] == "start":
		add("started", strings.Join(args, " "))
	case len(args) >= 2 && args[0] == "contract" && args[1] == "deploy":
		raw, _ := os.ReadFile(state("deploys"))
		n, _ := strconv.Atoi(strings.TrimSpace(string(raw)))
		_ = os.WriteFile(state("deploys"), []byte(strconv.Itoa(n+1)), 0o644)
		fmt.Println("ℹ️  Deploying…")
		fmt.Println("C" + strings.Repeat(string(rune('A'+n)), 55))
	case len(args) >= 2 && args[0] == "contract" && args[1] == "upload":
		raw, err := os.ReadFile(flag(args, "--wasm"))
		if err != nil {
			fail(err.Error())
		}
		sum := sha256.Sum256(raw)
		fmt.Println(hex.EncodeToString(sum[:]))
	case len(args) >= 2 && args[0] == "contract" && args[1] == "invoke":
		if fn := os.Getenv("FAKEBIN_INVOKE_FAIL"); fn != "" && strings.Contains(strings.Join(args, " "), "-- "+fn) {
			fail("error: transaction simulation failed")
		}
	case len(args) >= 3 && args[0] == "contract" && args[1] == "bindings":
		dir := flag(args, "--output-dir")
		_ = os.MkdirAll(dir, 0o755)
		_ = os.WriteFile(filepath.Join(dir, "index.ts"), []byte("// bindings\n"), 0o644)
	default:
		fail("fakebin: unsupported stellar invocation: " + strings.Join(args, " "))
	}
}
