package api

import (
	"bufio"
	"context"
	"net/http"
	"strings"
	"sync"
)

// stellarTOMLPath is where a deployment publishes its SEP-1 document
// (apps/web/app/.well-known/stellar.toml/route.ts).
const stellarTOMLPath = "/.well-known/stellar.toml"

// maxTextBytes bounds a plain-text response. A real stellar.toml from a
// Signet deployment is four lines; SEP-1 documents in general are small.
const maxTextBytes = 64 << 10

// rawText is a response destination that asks once() for the body verbatim
// instead of decoding JSON.
type rawText string

// Discovery is what a deployment says about itself in its stellar.toml (#618).
type Discovery struct {
	// URL is the deployment this was discovered from, normalised.
	URL string
	// NetworkPassphrase is the network the deployment is configured for.
	NetworkPassphrase string
	// SigningKey is the deployment's SEP-10 signing key.
	SigningKey string
	// WebAuthEndpoint is the deployment's SEP-10 endpoint.
	WebAuthEndpoint string
}

// discoveries caches Discover results for the process lifetime, per
// deployment URL: a deployment's network does not change mid-command, and
// link and unlink must not pay for it twice. Failures are not cached.
var discoveries sync.Map // baseURL -> Discovery

// Discover fetches and parses the deployment's stellar.toml, once per process.
//
// It goes through the same transport as every other request — so https is
// enforced, transient failures are retried, and a refusal is an *Error
// carrying its status (a deployment that predates the document answers 404).
func (c *Client) Discover(ctx context.Context) (Discovery, error) {
	if cached, ok := discoveries.Load(c.baseURL); ok {
		return cached.(Discovery), nil
	}
	var body rawText
	if err := c.do(ctx, http.MethodGet, stellarTOMLPath, nil, &body, true); err != nil {
		return Discovery{}, err
	}
	d := parseStellarTOML(string(body))
	d.URL = c.baseURL
	discoveries.Store(c.baseURL, d)
	return d, nil
}

// parseStellarTOML reads the three top-level keys signet needs, without a
// TOML dependency: `KEY = "value"` lines before the first table header.
// Everything else — other keys, comments, arrays, [[tables]] — is skipped,
// and a key that is absent stays empty.
func parseStellarTOML(doc string) Discovery {
	var d Discovery
	scanner := bufio.NewScanner(strings.NewReader(doc))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "[") {
			// The first table header ends the top level; NETWORK_PASSPHRASE
			// under, say, [DOCUMENTATION] would be a different key.
			break
		}
		key, raw, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		value, ok := tomlString(strings.TrimSpace(raw))
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "NETWORK_PASSPHRASE":
			d.NetworkPassphrase = value
		case "SIGNING_KEY":
			d.SigningKey = value
		case "WEB_AUTH_ENDPOINT":
			d.WebAuthEndpoint = value
		}
	}
	return d
}

// tomlString decodes a single-line TOML string: "basic" (with \" and \\
// escapes) or 'literal'. A trailing comment after the closing quote is
// allowed; anything else is not a string.
func tomlString(raw string) (string, bool) {
	if len(raw) < 2 {
		return "", false
	}
	switch raw[0] {
	case '\'':
		end := strings.IndexByte(raw[1:], '\'')
		if end < 0 || !onlyComment(raw[end+2:]) {
			return "", false
		}
		return raw[1 : end+1], true
	case '"':
		var b strings.Builder
		for i := 1; i < len(raw); i++ {
			switch ch := raw[i]; ch {
			case '\\':
				if i+1 >= len(raw) {
					return "", false
				}
				i++
				switch raw[i] {
				case '"', '\\':
					b.WriteByte(raw[i])
				case 'n':
					b.WriteByte('\n')
				case 't':
					b.WriteByte('\t')
				default:
					return "", false
				}
			case '"':
				if !onlyComment(raw[i+1:]) {
					return "", false
				}
				return b.String(), true
			default:
				b.WriteByte(ch)
			}
		}
	}
	return "", false
}

func onlyComment(rest string) bool {
	rest = strings.TrimSpace(rest)
	return rest == "" || strings.HasPrefix(rest, "#")
}
