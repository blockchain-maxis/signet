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
	"bufio"
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

// ErrNoIdentities is returned by Resolve when `stellar keys ls` lists nothing.
var ErrNoIdentities = fmt.Errorf(
	"%w: no Stellar identities found — run `stellar keys generate <name>` first",
	exitcode.ErrNoIdentity,
)

// ErrAmbiguousIdentity is returned by Resolve when several identities exist,
// none was named explicitly, and no interactive prompt was supplied.
var ErrAmbiguousIdentity = fmt.Errorf(
	"%w: multiple Stellar identities exist — specify one with --source",
	exitcode.ErrNoIdentity,
)

// List returns the names of every identity `stellar keys ls` knows about, in
// the order `stellar` prints them.
//
// Goes through the same CheckStellarCLI guard and `run` seam as
// ResolvePublicKey, so a missing or too-old `stellar` is reported the same way
// here as anywhere else.
func List(binary string) ([]string, error) {
	if binary == "" {
		binary = DefaultBinary
	}
	if err := CheckStellarCLI(binary); err != nil {
		return nil, err
	}

	stdout, stderr, err := run(binary, "keys", "ls")
	if err != nil {
		msg := strings.TrimSpace(string(stderr))
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("%w: listing identities: %s", exitcode.ErrNoIdentity, msg)
	}

	var names []string
	scanner := bufio.NewScanner(strings.NewReader(string(stdout)))
	for scanner.Scan() {
		if line := strings.TrimSpace(scanner.Text()); line != "" {
			names = append(names, line)
		}
	}
	return names, nil
}

// Resolve picks the identity to sign with:
//
//   - `explicit`, if the caller (e.g. `--source`) already named one;
//   - the sole identity, if `stellar keys ls` lists exactly one;
//   - otherwise, whatever `prompt` returns when given the full list — the
//     command layer wires this to an interactive selector. A non-interactive
//     caller (CI, `--json`) passes a nil prompt and gets ErrAmbiguousIdentity
//     instead of a hanging read.
//
// Resolve only ever deals in identity *names* and public keys; the secret
// never leaves `stellar`, which is the whole point of delegating (issue #253).
func Resolve(binary, explicit string, prompt func([]string) (string, error)) (string, error) {
	if explicit != "" {
		return explicit, nil
	}

	names, err := List(binary)
	if err != nil {
		return "", err
	}

	switch len(names) {
	case 0:
		return "", ErrNoIdentities
	case 1:
		return names[0], nil
	default:
		if prompt != nil {
			return prompt(names)
		}
		return "", fmt.Errorf("%w (found: %s)", ErrAmbiguousIdentity, strings.Join(names, ", "))
	}
}
