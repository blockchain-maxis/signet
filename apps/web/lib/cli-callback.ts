/**
 * Posting the approval result from the browser back to the CLI's loopback
 * server.
 *
 * The failure this exists for: a cross-origin `fetch` that the browser blocks
 * rejects with an opaque `TypeError: Failed to fetch` and nothing else. No
 * status, no reason, and — critically — no way to tell "Chrome refused the
 * private-network request" from "the CLI already exited". Left alone, the page
 * shows a spinner, the CLI waits out its timeout, and the developer has two
 * components that both look hung and neither of which says why.
 *
 * So every path here ends in a typed reason, and there is always a deadline.
 */

/** What went wrong, in terms the page can turn into a sentence. */
export type CliCallbackFailure =
  /** The browser blocked the request — almost always the PNA preflight. */
  | 'blocked'
  /** No answer in time. The CLI is probably gone. */
  | 'timeout'
  /** The loopback server answered, and refused. */
  | 'refused'
  /** The loopback server answered with something unusable. */
  | 'invalid-response';

export interface CliCallbackError {
  ok: false;
  reason: CliCallbackFailure;
  /** Shown to the developer. Names the likely cause and the next step. */
  message: string;
}

export type CliCallbackResult = { ok: true } | CliCallbackError;

/** Default deadline. Long enough for a slow local server, short enough to not read as a hang. */
export const CALLBACK_TIMEOUT_MS = 10_000;

const MESSAGES: Record<CliCallbackFailure, string> = {
  blocked:
    'Your browser blocked the request to the Signet CLI on this machine. ' +
    "This is usually Chrome's Private Network Access check: the CLI must be running and " +
    'recent enough to answer the preflight. Update the CLI and run `signet link` again.',
  timeout:
    'The Signet CLI did not answer. It may have exited or timed out — ' +
    'run `signet link` again and approve while it is still waiting.',
  refused:
    'The Signet CLI rejected this approval. It was most likely waiting for a different ' +
    'pairing — run `signet link` again and approve the code it prints.',
  'invalid-response':
    'The Signet CLI answered with something unexpected. Update the CLI and try again.',
};

function failure(reason: CliCallbackFailure): CliCallbackError {
  return { ok: false, reason, message: MESSAGES[reason] };
}

/**
 * POST the approval payload to `loopbackUrl`.
 *
 * Never throws and never hangs: it resolves with a typed result either way, so
 * the caller renders an explanation instead of a spinner.
 */
export async function postToCli(
  loopbackUrl: string,
  payload: unknown,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<CliCallbackResult> {
  const timeoutMs = options.timeoutMs ?? CALLBACK_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(loopbackUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
      // The result matters, so the response must be readable. `no-cors` would
      // "succeed" with an opaque response and report success for a request
      // the CLI never accepted.
      mode: 'cors',
    });

    if (res.status === 403 || res.status === 400) return failure('refused');
    if (!res.ok) return failure('invalid-response');
    return { ok: true };
  } catch (err) {
    // An abort is our own deadline firing.
    if (controller.signal.aborted) return failure('timeout');
    // Everything else a blocked cross-origin fetch produces is a bare
    // TypeError with no detail, which is exactly the case worth naming.
    if (err instanceof TypeError) return failure('blocked');
    return failure('invalid-response');
  } finally {
    clearTimeout(timer);
  }
}
