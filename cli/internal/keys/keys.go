// Package keys manages local Stellar signing identities used by the CLI.
// Rather than embedding key storage or ed25519 signing itself — a tool that
// sits next to deploy keys should have as small a supply chain as possible —
// it shells out to the user's locally installed `stellar` CLI, which already
// owns identity storage (`stellar keys generate/add`) and threads
// --network/--network-passphrase itself. Signing a transaction (`stellar tx
// sign`) is a follow-up; this package currently only resolves a named
// identity to its public key.
package keys

import (
	"bytes"
	"fmt"
	"os/exec"
	"regexp"
	"strings"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// DefaultBinary is the `stellar` CLI executable name looked up on PATH.
const DefaultBinary = "stellar"

// publicKeyPattern is a charset/length check only (Stellar's StrKey ed25519
// public key), not a checksum validation — mirrors internal/link's.
var publicKeyPattern = regexp.MustCompile(`^G[A-Z2-7]{55}$`)

// commandRunner is the exec seam tests substitute a fake `stellar` binary
// through, by pointing it at a script/binary on PATH.
type commandRunner func(binary string, args ...string) ([]byte, []byte, error)

func runCommand(binary string, args ...string) ([]byte, []byte, error) {
	cmd := exec.Command(binary, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.Bytes(), stderr.Bytes(), err
}

var run commandRunner = runCommand

// ResolvePublicKey resolves a named local identity (as `stellar keys
// generate <name>` / `stellar keys add <name>` would have created) to its
// Stellar public key, by shelling out to `<binary> keys address <source>`.
//
// binary is normally DefaultBinary; callers (and tests) may point it at a
// specific path. An empty source, a binary that isn't on PATH, or output
// that isn't a well-formed public key are all reported as errors — this
// never returns a value that isn't already shape-valid.
func ResolvePublicKey(binary, source string) (string, error) {
	if binary == "" {
		binary = DefaultBinary
	}
	if source == "" {
		return "", fmt.Errorf("identity name is required")
	}

	// Check the dependency before using it. Without this, a missing or too-old
	// `stellar` surfaces as a raw exec error or an unrecognized-flag message
	// that points at the wrong tool entirely — which is the whole point of
	// issue #297. Doing it here rather than in each command means every path
	// that shells out to `stellar` is covered by construction, including the
	// identity resolution still to land.
	if err := CheckStellarCLI(binary); err != nil {
		return "", err
	}

	stdout, stderr, err := run(binary, "keys", "address", source)
	if err != nil {
		msg := strings.TrimSpace(string(stderr))
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("%w: resolving identity %q: %s", exitcode.ErrNoIdentity, source, msg)
	}

	publicKey := strings.TrimSpace(string(stdout))
	if !publicKeyPattern.MatchString(publicKey) {
		return "", fmt.Errorf("%w: identity %q resolved to something that isn't a Stellar public key", exitcode.ErrNoIdentity, source)
	}
	return publicKey, nil
}
