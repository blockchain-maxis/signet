// Package networkcheck compares the network a command was asked for with the
// one the deployment is configured for, before anything is requested (#618).
//
// A deployment serves exactly one network and says which in its stellar.toml
// (api.Discover). Since #616 the server refuses a mismatched pair/start with
// a 400 — but only after the CLI has resolved an identity and opened a
// pairing. Checking first turns that into a configuration error (exit 3)
// that names both networks and the fix, before any of it happens.
//
// The names and passphrases mirror packages/types/src/network.ts, the
// table the server normalises with.
package networkcheck

import (
	"fmt"
	"strings"

	"github.com/blockchain-maxis/signet/cli/internal/api"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/redact"
)

// passphrases is the canonical name -> passphrase table.
var passphrases = map[string]string{
	"testnet":   "Test SDF Network ; September 2015",
	"mainnet":   "Public Global Stellar Network ; September 2015",
	"futurenet": "Test SDF Future Network ; October 2022",
	"local":     "Standalone Network ; February 2017",
}

// Normalize maps a network name or alias to its canonical name: `public` and
// `pubnet` are `mainnet`, case and surrounding space are ignored. The second
// result is false for a name the table does not know.
func Normalize(name string) (string, bool) {
	n := strings.ToLower(strings.TrimSpace(name))
	if n == "public" || n == "pubnet" {
		n = "mainnet"
	}
	_, ok := passphrases[n]
	return n, ok
}

// PassphraseFor is the passphrase of a canonical network name.
func PassphraseFor(name string) (string, bool) {
	p, ok := passphrases[name]
	return p, ok
}

// NameFor is the canonical name of a network passphrase, if it is one of the
// known networks.
func NameFor(passphrase string) (string, bool) {
	for name, p := range passphrases {
		if p == passphrase {
			return name, true
		}
	}
	return "", false
}

// MismatchError is a requested network the deployment does not serve. It
// wraps exitcode.ErrConfiguration: the fix is a flag or a context, not a
// retry.
type MismatchError struct {
	// Requested is the network as the command resolved it (flag, env or context).
	Requested string
	// DeploymentURL is the deployment that published Passphrase.
	DeploymentURL string
	// Passphrase is the deployment's NETWORK_PASSPHRASE.
	Passphrase string
}

func (e *MismatchError) Error() string {
	served := fmt.Sprintf("%q", e.Passphrase)
	fix := "point signet at a deployment for " + e.Requested
	if name, ok := NameFor(e.Passphrase); ok {
		served = fmt.Sprintf("%s (%q)", name, e.Passphrase)
		fix = fmt.Sprintf("use --network %s, or signet context use <name> for a context on %s", name, name)
	}
	return fmt.Sprintf(
		"%v: signet is set to network %s, but %s serves %s; %s",
		exitcode.ErrConfiguration, e.Requested, redact.Secrets(e.DeploymentURL), served, fix,
	)
}

func (e *MismatchError) Unwrap() error { return exitcode.ErrConfiguration }

// Compare checks the requested network against what the deployment
// published. It returns nil when they agree, or when the deployment
// published no NETWORK_PASSPHRASE (there is nothing to compare; the server
// still checks at pair/start). A requested name signet does not know cannot
// match any deployment, so it is a mismatch too.
func Compare(requested string, deployment api.Discovery) error {
	if deployment.NetworkPassphrase == "" {
		return nil
	}
	name, known := Normalize(requested)
	if known && passphrases[name] == deployment.NetworkPassphrase {
		return nil
	}
	shown := strings.TrimSpace(requested)
	if known {
		shown = name
	}
	return &MismatchError{Requested: shown, DeploymentURL: deployment.URL, Passphrase: deployment.NetworkPassphrase}
}
