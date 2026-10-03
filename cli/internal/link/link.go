// Package link binds a local deploy wallet to a Signet handle: it drives the
// browser-approved pairing flow (see flow.go) and holds the shape checks that
// keep malformed input — and a mistyped secret key — out of it.
package link

import (
	"fmt"
	"regexp"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/redact"
)

// handlePattern mirrors HANDLE_PATTERN in packages/types/src/handle.ts:
// ASCII lowercase, digits, underscore, hyphen, 1 to 32 characters.
var handlePattern = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)

// publicKeyPattern is a charset/length check only (Stellar's StrKey ed25519
// public key: 'G' followed by 55 base32 characters) — it does not verify the
// StrKey checksum. Real key material isn't handled by this package yet
// (see internal/keys), so this is deliberately the same shallow shape check
// as a first filter, not a substitute for validating a real key.
var publicKeyPattern = regexp.MustCompile(`^G[A-Z2-7]{55}$`)

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

// ValidateHandle checks a Signet handle's shape.
func ValidateHandle(handle string) error {
	if !handlePattern.MatchString(handle) {
		return &ValidationError{
			fmt.Sprintf(
				"invalid handle %q: expected 1-32 lowercase letters, digits, _, or -",
				redact.Secrets(handle),
			),
		}
	}
	return nil
}

// ValidatePublicKey checks a Stellar public key's shape.
//
// Deliberately does not echo the value back: unlike a handle, this could be a
// Stellar *secret* key passed to the wrong flag by mistake, and an error
// message is not where anyone should find that out.
func ValidatePublicKey(publicKey string) error {
	if !publicKeyPattern.MatchString(publicKey) {
		return &ValidationError{"invalid public key: expected a Stellar G... address"}
	}
	return nil
}
