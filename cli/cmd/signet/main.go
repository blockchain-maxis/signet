// Command signet is the CLI companion to the Signet developer identity
// registry on Stellar/Soroban: it links wallets to on-chain handles, manages
// local signing keys, and talks to a Signet deployment over its HTTP API.
package main

import (
	"fmt"
	"os"

	"github.com/blockchain-maxis/signet/cli/internal/cmd"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
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
	err := cmd.Execute(version, commit)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		// Exit code 1 is the untaxonomized failure class: signet could not
		// classify what went wrong, which is exactly when a report is worth
		// filing. The specific failure classes have their own codes and their
		// own actionable messages, so the note would only be noise there.
		if cmd.ExitCode(err) == exitcode.Generic {
			fmt.Fprintln(os.Stderr, "This looks like a bug. Run `signet bug-report` for a redacted report you can open as an issue.")
		}
	}
	os.Exit(cmd.ExitCode(err))
}
