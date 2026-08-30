// Package link will bind a local wallet key to a Signet handle through the
// Identity Registry's claim/release/transfer operations. Scaffolded here;
// implemented in a follow-up issue.
package link

import (
	"fmt"
	"regexp"
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
		return Result{}, fmt.Errorf("invalid handle %q: expected 1-32 lowercase letters, digits, _, or -", handle)
	}
	if !publicKeyPattern.MatchString(publicKey) {
		return Result{}, fmt.Errorf("invalid public key %q: expected a Stellar G... address", publicKey)
	}
	return Result{
		Handle:    handle,
		PublicKey: publicKey,
		Network:   network,
		Status:    "ok",
	}, nil
}
