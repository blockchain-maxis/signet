// Command signet is the CLI companion to the Signet developer identity
// registry on Stellar/Soroban: it links wallets to on-chain handles, manages
// local signing keys, and talks to a Signet deployment over its HTTP API.
package main

import (
	"fmt"
	"os"

	"github.com/blockchain-maxis/signet/cli/internal/cmd"
)

// version and commit are overridden at build time via:
//
//	go build -ldflags "-X main.version=$(git describe --tags) -X main.commit=$(git rev-parse --short HEAD)"
//
// They default to "dev"/"none" for a plain `go build` or `go run`.
var (
	version = "dev"
	commit  = "none"
)

func main() {
	if err := cmd.Execute(version, commit); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
