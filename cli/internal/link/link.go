// Package link will bind a local wallet key to a Signet handle through the
// Identity Registry's claim/release/transfer operations. Scaffolded here;
// implemented in a follow-up issue.
package link

import (
	"fmt"
	"regexp"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// Result is the outcome of a link operation — the fields the CLI's --json
// output mode reports.
type Result struct {
	Handle    string `json:"handle"`
	PublicKey string `json:"publicKey"`
	Network   string `json:"network"`
	Status    string `json:"status"`
}

// handlePattern mirrors HANDLE_PATTERN in packages/types/src/handle.ts:
// ASCII lowercase, digits, underscore, hyphen, 1 to 32 characters.
var handlePattern = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)

// publicKeyPattern is a charset/length check only (Stellar's StrKey ed25519
// public key: 'G' followed by 55 base32 characters) — it does not verify the
// StrKey checksum. Real key material isn't handled by this package yet
// (see internal/keys), so this is deliberately the same shallow shape check
// as a first filter, not a substitute for validating a real key.
var publicKeyPattern = regexp.MustCompile(`^G[A-Z2-7]{55}$`)

// secretPattern matches a Stellar StrKey secret seed. Used only to keep one
// out of an error message — see redactSecrets.
var secretPattern = regexp.MustCompile(`\bS[A-Z2-7]{55}\b`)

// redactSecrets replaces anything shaped like a Stellar secret seed before it
// goes into an error message.
//
// Echoing an invalid value back is genuinely useful — it is how someone spots
// a typo — but a mistyped flag is exactly how a secret seed ends up in the
// wrong argument slot, and an error message ends up in shell history, a CI
// log, and a pasted bug report. So the value is still shown, unless showing
// it would disclose a key.
func redactSecrets(value string) string {
	return secretPattern.ReplaceAllString(value, "[redacted: secret-shaped value]")
}

// ValidationError reports invalid input to Link — the caller's mistake, not
// an unexpected failure. It maps to ExitInvalidInput (see internal/cmd's
// ExitCoder), distinguishing "you gave it something invalid" from "something
// else went wrong" in the process's exit code.
type ValidationError struct {
	msg string
}

func (e *ValidationError) Error() string { return e.msg }

// ExitCode implements internal/cmd.ExitCoder.
func (e *ValidationError) ExitCode() int { return exitcode.InvalidInput }

// Link validates handle and publicKey and reports the outcome for the given
// network.
//
// This does not yet perform a real on-chain claim or call a Signet
// deployment's HTTP API — internal/keys (local signing) and internal/spec
// (the deployment's typed API models) are themselves still scaffolded, so
// there is nothing yet to actually invoke. Result's shape is the real,
// stable output contract --json commits to; the network call itself lands
// in a follow-up issue.
func Link(handle, publicKey, network string) (Result, error) {
	if !handlePattern.MatchString(handle) {
		return Result{}, &ValidationError{
			fmt.Sprintf(
				"invalid handle %q: expected 1-32 lowercase letters, digits, _, or -",
				redactSecrets(handle),
			),
		}
	}
	if !publicKeyPattern.MatchString(publicKey) {
		// Deliberately does not echo publicKey back: unlike a handle, this
		// value could be a Stellar *secret* key a user passed to the wrong
		// flag by mistake, and an error message is not the place to find out.
		return Result{}, &ValidationError{
			"invalid public key: expected a Stellar G... address",
		}
	}
	return Result{
		Handle:    handle,
		PublicKey: publicKey,
		Network:   network,
		Status:    "ok",
	}, nil
}
