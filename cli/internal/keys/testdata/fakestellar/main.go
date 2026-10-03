// Command fakestellar is a stand-in for the real `stellar` CLI, used only by
// keys_test.go and command regression tests. It understands the identity,
// version, and tx-sign invocations those tests make, with behavior selected by
// the requested name or FAKESTELLAR_* environment variables so tests do not
// need to build multiple binaries.
package main

import (
	"fmt"
	"os"
	"strings"
)

func main() {
	args := os.Args[1:]

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
