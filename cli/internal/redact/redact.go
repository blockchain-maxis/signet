// Package redact keeps secret-shaped values out of anything signet prints.
package redact

import "regexp"

// secretPattern matches a Stellar StrKey secret seed.
var secretPattern = regexp.MustCompile(`\bS[A-Z2-7]{55}\b`)

// apiKeyPattern matches a Signet API key (#651): the `sgk_` prefix, an
// eight-character base64url prefix, then the secret. The key is redacted
// wholesale. The prefix alone is not sensitive, but there is no reason to
// reproduce any of it in a bug report.
var apiKeyPattern = regexp.MustCompile(`\bsgk_[A-Za-z0-9_-]{8,}\b`)

// authorizationPattern matches an `Authorization:`/`Authorization=` header or
// field, keeping the name so the diagnostic still says *what* was redacted and
// masking the rest of the line, which may include a scheme and a token.
var authorizationPattern = regexp.MustCompile(`(?i)(authorization\s*[:=]\s*)[^\r\n]+`)

// Placeholder is what a secret-shaped value is replaced with.
const Placeholder = "[redacted: secret-shaped value]"

// AuthorizationPlaceholder replaces the value of an Authorization header.
const AuthorizationPlaceholder = "[redacted: authorization]"

// Secrets replaces anything shaped like a Stellar secret seed, a Signet API
// key, or an Authorization value in value while preserving the surrounding
// text that makes diagnostics actionable.
func Secrets(value string) string {
	value = secretPattern.ReplaceAllString(value, Placeholder)
	value = apiKeyPattern.ReplaceAllString(value, Placeholder)
	value = authorizationPattern.ReplaceAllString(value, "${1}"+AuthorizationPlaceholder)
	return value
}
