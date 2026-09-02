// Command fakestellar is a stand-in for the real `stellar` CLI, used only by
// keys_test.go. It understands exactly the invocation ResolvePublicKey
// makes — `stellar keys address <name>` — and its behavior is chosen by the
// requested name, so the test doesn't need extra environment plumbing.
package main

import (
	"fmt"
	"os"
)

func main() {
	args := os.Args[1:]
	if len(args) != 3 || args[0] != "keys" || args[1] != "address" {
		fmt.Fprintln(os.Stderr, "fakestellar: unsupported invocation")
		os.Exit(2)
	}

	switch args[2] {
	case "alice":
		fmt.Println("GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD")
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
