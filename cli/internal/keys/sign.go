package keys

import (
	"bytes"
	"fmt"
	"os/exec"
	"strings"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// stdinRunner is the exec seam for `stellar` invocations that take a
// transaction envelope on stdin. Separate from commandRunner because signing
// is the only thing here that writes to the child process, and because tests
// need to assert what was piped in.
type stdinRunner func(binary, stdin string, args ...string) ([]byte, []byte, error)

func runCommandWithStdin(binary, stdin string, args ...string) ([]byte, []byte, error) {
	cmd := exec.Command(binary, args...)
	cmd.Stdin = strings.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.Bytes(), stderr.Bytes(), err
}

var runStdin stdinRunner = runCommandWithStdin

// SignChallenge signs a SEP-10 challenge transaction with the named local
// identity and returns the signed envelope.
//
// The secret key never enters this process. `stellar` owns the keystore and
// does the signing; signet pipes it a base64 envelope and reads one back. That
// is the same bargain the rest of this package makes — a tool that lives next
// to deploy keys should have as small a claim on them as possible — and it is
// why signing is a subprocess rather than an ed25519 call.
//
// `--sign-with-key` and reading the transaction from stdin both landed in
// stellar 25.2.0, which CheckStellarCLI already enforces (see
// MinimumStellarVersion), so neither is probed for here.
func SignChallenge(binary, source, unsignedXDR string) (string, error) {
	if binary == "" {
		binary = DefaultBinary
	}
	if source == "" {
		return "", fmt.Errorf("%w: no identity to sign with", exitcode.ErrSigningFailure)
	}
	if strings.TrimSpace(unsignedXDR) == "" {
		return "", fmt.Errorf("%w: nothing to sign", exitcode.ErrSigningFailure)
	}
	if err := CheckStellarCLI(binary); err != nil {
		return "", err
	}

	stdout, stderr, err := runStdin(binary, unsignedXDR, "tx", "sign", "--sign-with-key", source)
	if err != nil {
		// `stellar`'s own stderr is the useful part — "identity not found",
		// "wrong passphrase", a hardware wallet declining. Passed through
		// rather than replaced, but trimmed so a multi-line dump does not
		// bury the reason.
		detail := strings.TrimSpace(string(stderr))
		if detail == "" {
			detail = err.Error()
		}
		return "", fmt.Errorf("%w: %s tx sign: %s", exitcode.ErrSigningFailure, binary, detail)
	}

	signed := strings.TrimSpace(string(stdout))
	if signed == "" {
		return "", fmt.Errorf(
			"%w: %s tx sign produced no output", exitcode.ErrSigningFailure, binary,
		)
	}
	// Deliberately does not echo the envelope on a malformed result. It is not
	// secret, but it is long, and an error line is not where anyone wants a
	// base64 blob — the exit code and the sentence say what went wrong.
	if !looksLikeXDR(signed) {
		return "", fmt.Errorf(
			"%w: %s tx sign did not return a transaction envelope",
			exitcode.ErrSigningFailure, binary,
		)
	}
	return signed, nil
}

// looksLikeXDR is a shape check, not a decode: base64 with no whitespace and
// long enough to be an envelope rather than an error string that happened to
// reach stdout.
func looksLikeXDR(s string) bool {
	if len(s) < 32 || strings.ContainsAny(s, " \t\n\r") {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		case r == '+', r == '/', r == '=':
		default:
			return false
		}
	}
	return true
}
