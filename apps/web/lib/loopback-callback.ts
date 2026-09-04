/**
 * Validation for the `callback` URL `signet link` puts in its approval link.
 *
 * After approving, the page redirects the browser to the CLI's local listener
 * so the terminal finishes immediately instead of waiting for its next poll.
 * That redirect is attacker-reachable — anyone can craft
 * `/link?code=…&callback=…` and send it to a signed-in developer — so the
 * value is never used as given. Without this check the approval page is an
 * open redirect on a domain people are about to trust with a wallet link.
 *
 * Only a loopback HTTP URL is allowed, because that is the only thing the CLI
 * can ever be listening on: `loopback.New` binds 127.0.0.1 and nothing else.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

export function safeCallbackUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  // http only: the CLI's listener has no certificate, and allowing https here
  // would let the value point at a real site.
  if (parsed.protocol !== 'http:') return null;
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  // Credentials in a redirect target are never legitimate here and are a
  // classic way to make a hostile URL read as a familiar one.
  if (parsed.username || parsed.password) return null;

  return parsed.toString();
}
