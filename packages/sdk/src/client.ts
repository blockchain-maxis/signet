import type { Handle, ProfileResponse, RegistryEntry, RegistryCount } from '@signet/types';
import { ApiError, NetworkError, NotFoundError } from './errors.ts';

export interface SignetClientOptions {
  /**
   * Base URL of a Signet deployment, e.g. `http://localhost:3000` for a local
   * dev server. Required: there is no hosted public deployment yet, so a
   * default would silently point at a host that doesn't serve the API.
   */
  baseUrl: string;
  /** Optional fetch implementation (for tests / non-browser runtimes). */
  fetch?: typeof fetch;
  /**
   * Per-attempt timeout in milliseconds (default 10000). An attempt that takes
   * longer is aborted via `AbortController`; once retries are exhausted the
   * call rejects with `NetworkError` rather than hanging on a stalled socket.
   */
  timeoutMs?: number;
  /**
   * How many times to retry a failed request (default 2, so up to 3 attempts).
   * Retries cover 5xx responses and network/timeout failures, with exponential
   * backoff (200ms, 400ms, 800ms …, capped at 5s). A 404 and any other 4xx are
   * answers, not glitches, so they are never retried. Set to 0 to disable.
   */
  maxRetries?: number;
}

/** Per-attempt timeout, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Retries after the initial attempt. */
const DEFAULT_MAX_RETRIES = 2;
/** Ceiling on a single backoff delay, in milliseconds. */
const MAX_BACKOFF_MS = 5_000;

/** An `AbortController`-aborted fetch, across browsers and Node 17+. */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Public SDK client for the Signet API.
 *
 * Talks to the tRPC endpoint over its HTTP GET form
 * (`/api/trpc/{procedure}?input=…`) so external integrators don't need the
 * tRPC client library.
 *
 * Every request is bounded by `timeoutMs` and retried up to `maxRetries` times
 * on 5xx / network failures — see `SignetClientOptions` for the defaults.
 */
export class SignetClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: SignetClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!this.fetchImpl) {
      throw new Error('[signet] no fetch implementation available; pass options.fetch');
    }
  }

  /** Exponential backoff between attempts: 200ms, 400ms, 800ms …, capped. */
  private backoff(attempt: number): Promise<void> {
    const delay = Math.min(200 * 2 ** attempt, MAX_BACKOFF_MS);
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  /**
   * Issues a tRPC GET query. Throws a typed error the caller can discriminate:
   * `NetworkError` when the request never reached the server (including a
   * timeout), `NotFoundError` on a 404, or `ApiError` (carrying the status) on
   * any other non-OK response. Transient failures are retried first; the error
   * that surfaces is the one from the final attempt.
   */
  private async query<T>(procedure: string, input: unknown): Promise<T | null> {
    const url = `${this.baseUrl}/api/trpc/${procedure}?input=${encodeURIComponent(
      JSON.stringify(input),
    )}`;

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      // The timer covers reading the body too, not just the response headers —
      // a server that streams one byte an hour is as stalled as a dead socket.
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        let res: Response;
        try {
          res = await this.fetchImpl(url, {
            headers: { accept: 'application/json' },
            signal: controller.signal,
          });
        } catch (cause) {
          if (attempt < this.maxRetries) {
            await this.backoff(attempt);
            continue;
          }
          throw new NetworkError(
            isAbortError(cause)
              ? `request to ${procedure} timed out after ${this.timeoutMs}ms`
              : `request to ${procedure} failed`,
            { cause },
          );
        }

        if (!res.ok) {
          if (res.status === 404) throw new NotFoundError(`${procedure} not found`);
          if (res.status >= 500 && attempt < this.maxRetries) {
            await this.backoff(attempt);
            continue;
          }
          throw new ApiError(`${procedure} failed with status ${res.status}`, res.status);
        }

        const body = (await res.json()) as { result?: { data?: T } };
        return body.result?.data ?? null;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /**
   * As `query`, but for the lookups whose documented contract is "null when the
   * thing isn't there". A 404 is that answer, not a failure; every other error
   * still propagates so callers can tell a missing handle from a broken server.
   */
  private async queryNullable<T>(procedure: string, input: unknown): Promise<T | null> {
    try {
      return await this.query<T>(procedure, input);
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  /**
   * Fetch a developer's profile + on-chain stats, or `null` if not found. Other
   * failures (network down, server error) throw the corresponding typed error.
   */
  async getProfile(handle: Handle): Promise<ProfileResponse | null> {
    return this.queryNullable<ProfileResponse>('profile.byHandle', { handle });
  }

  /** List every curated handle in the registry. */
  async listHandles(): Promise<Handle[]> {
    return (await this.query<Handle[]>('profile.list', undefined)) ?? [];
  }

  /** Resolve a handle to its bound wallet address, or null if unregistered. */
  async resolveHandle(handle: Handle): Promise<RegistryEntry | null> {
    return this.queryNullable<RegistryEntry>('registry.resolve', { handle });
  }

  /** Reverse-lookup: find the handle bound to a wallet address. */
  async lookupWallet(wallet: string): Promise<RegistryEntry | null> {
    return this.queryNullable<RegistryEntry>('registry.lookup', { wallet });
  }

  /**
   * Return the registry's own binding counter — an upper bound, not a live
   * total: a binding that lapses from on-chain storage unaccessed is never
   * subtracted. Resolve a specific handle to prove a binding is live. A
   * failed query coerces to `{ count: 0 }`; callers that must distinguish
   * "unreadable" from "empty" should use the tRPC endpoint directly, whose
   * `count` is `null` when the registry could not be read.
   */
  async countRegistryEntries(): Promise<RegistryCount> {
    return (await this.query<RegistryCount>('registry.count', undefined)) ?? { count: 0 };
  }
}
