package keys

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// ErrNoIdentities is returned by Resolve when `stellar keys ls` lists nothing.
var ErrNoIdentities = errors.New("no Stellar identities found — run `stellar keys generate <name>` first")

// ErrAmbiguousIdentity is returned by Resolve when several identities exist,
// none was named explicitly, and no interactive prompt was supplied.
var ErrAmbiguousIdentity = errors.New("multiple Stellar identities exist — specify one with --source")

// Runner abstracts running the `stellar` binary, so tests can substitute a
// fake one instead of shelling out to a real installation.
type Runner interface {
	Run(ctx context.Context, args ...string) (stdout string, err error)
}

// ExecRunner runs the real `stellar` binary found on PATH.
type ExecRunner struct {
	// Bin overrides the executable name/path. Empty means "stellar" (resolved via PATH).
	Bin string
}

// Run shells out to `stellar <args...>`, returning stdout on success. On a
// non-zero exit it returns stderr (trimmed) as the error, which is what
// surfaces `stellar`'s own diagnostics ("no identity 'x' found", etc.)
// straight through to the signet user instead of a bare "exit status 1".
func (r ExecRunner) Run(ctx context.Context, args ...string) (string, error) {
	bin := r.Bin
	if bin == "" {
		bin = "stellar"
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("stellar %s: %s", strings.Join(args, " "), msg)
	}
	return stdout.String(), nil
}

// List returns the names of every identity `stellar keys ls` knows about, in
// the order `stellar` prints them.
func List(ctx context.Context, r Runner) ([]string, error) {
	out, err := r.Run(ctx, "keys", "ls")
	if err != nil {
		return nil, err
	}
	var names []string
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		if line := strings.TrimSpace(scanner.Text()); line != "" {
			names = append(names, line)
		}
	}
	return names, nil
}

// PublicKey resolves `identity`'s G… address via `stellar keys public-key`.
// This is the only place a caller learns the public key — the secret never
// leaves `stellar`, including for hardware-wallet-backed identities.
func PublicKey(ctx context.Context, r Runner, identity string) (string, error) {
	out, err := r.Run(ctx, "keys", "public-key", identity)
	if err != nil {
		return "", err
	}
	pk := strings.TrimSpace(out)
	if len(pk) != 56 || pk[0] != 'G' {
		return "", fmt.Errorf("stellar keys public-key %s: unexpected output %q", identity, pk)
	}
	return pk, nil
}

// Resolve picks the identity to sign with:
//
//   - `explicit`, if the caller (e.g. `--source`) already named one;
//   - the sole identity, if `stellar keys ls` lists exactly one;
//   - otherwise, whatever `prompt` returns when given the full list — the
//     command layer wires this to an interactive selector. A non-interactive
//     caller (CI, `--json`) can pass a nil prompt and gets ErrAmbiguousIdentity
//     instead of a hanging read.
func Resolve(
	ctx context.Context,
	r Runner,
	explicit string,
	prompt func([]string) (string, error),
) (string, error) {
	if explicit != "" {
		return explicit, nil
	}

	names, err := List(ctx, r)
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
		return "", fmt.Errorf("%w: %s", ErrAmbiguousIdentity, strings.Join(names, ", "))
	}
}
