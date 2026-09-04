// Command fakestellar is a stand-in for the real `stellar` CLI, used only by
// keys_test.go. It understands the invocations ResolvePublicKey and
// CheckStellarCLI make — `stellar keys address <name>` and
// `stellar --version` — and its behavior is chosen by the requested name (or
// the FAKESTELLAR_VERSION env var, for --version), so tests don't need to
// build multiple binaries.
package main

import (
	"fmt"
	"os"
	"strings"
)

func main() {
	args := os.Args[1:]

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
