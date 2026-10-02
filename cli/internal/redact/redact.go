// Package redact keeps secret-shaped values out of anything signet prints.
package redact

import "regexp"

// secretPattern matches a Stellar StrKey secret seed.
var secretPattern = regexp.MustCompile(`\bS[A-Z2-7]{55}\b`)

// Placeholder is what a secret-shaped value is replaced with.
const Placeholder = "[redacted: secret-shaped value]"

// Secrets replaces anything shaped like a Stellar secret seed in value while
// preserving the surrounding text that makes diagnostics actionable.
func Secrets(value string) string {
	return secretPattern.ReplaceAllString(value, Placeholder)
}
