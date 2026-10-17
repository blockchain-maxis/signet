// Package redact keeps secret-shaped values out of anything signet prints.
package redact

import "regexp"

// secretPattern matches a Stellar StrKey secret seed.
var secretPattern = regexp.MustCompile(`\bS[A-Z2-7]{55}\b`)

// apiKeyPattern matches a Signet API key (sgk_...).
var apiKeyPattern = regexp.MustCompile(`\bsgk_[A-Za-z0-9_-]+\b`)

// Placeholder is what a secret-shaped value is replaced with.
const Placeholder = "[redacted: secret-shaped value]"

// Secrets replaces anything shaped like a Stellar secret seed or Signet API key in value while
// preserving the surrounding text that makes diagnostics actionable.
func Secrets(value string) string {
	redacted := secretPattern.ReplaceAllString(value, Placeholder)
	return apiKeyPattern.ReplaceAllString(redacted, Placeholder)
}
