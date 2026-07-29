import type { Handle, ProfileResponse } from '@signet/types';

export interface SignetClientOptions {
  /** Base URL of a Signet deployment, e.g. https://signet.dev */
  baseUrl?: string;
  /** Optional fetch implementation (for tests / non-browser runtimes). */
  fetch?: typeof fetch;
  /**
   * Request timeout in milliseconds (default 10000).
   * A stalled request that exceeds this limit is treated as "not found".
   */
  timeout?: number;
  /**
   * Max retries on 5xx responses (default 2).
   * Retries use a simple exponential backoff: 200ms * 2^attempt.
   */
  retries?: number;
}

/** Default timeout in milliseconds. */
const DEFAULT_TIMEOUT = 10_000;
/** Default max retries on server errors. */
const DEFAULT_RETRIES = 2;

/**
 * Public SDK client for the Signet API.
 *
 * Talks to the tRPC endpoint over its HTTP GET form
 * (`/api/trpc/{procedure}?input=…`) so external integrators don't need the
 * tRPC client library.
 *
 * Each request is protected by a configurable timeout (default 10s) and
 * automatic retries on 5xx responses (default 2 retries with exponential
 * backoff).
 */
export class SignetClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeout: number;
  private readonly retries: number;

  constructor(options: SignetClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://signet.dev').replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    if (!this.fetchImpl) {
      throw new Error('[signet] no fetch implementation available; pass options.fetch');
    }
  }

  private async query<T>(procedure: string, input: unknown): Promise<T | null> {
    const url = `${this.baseUrl}/api/trpc/${procedure}?input=${encodeURIComponent(
      JSON.stringify(input),
    )}`;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

      try {
        const res = await this.fetchImpl(url, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });

        if (!res.ok) {
          if (res.status >= 500 && res.status < 600 && attempt < this.retries) {
            await sleep(200 * Math.pow(2, attempt));
            continue;
          }
          return null;
        }

        const body = (await res.json()) as { result?: { data?: T } };
        return body.result?.data ?? null;
      } catch (err) {
        if (isAbortError(err)) {
          return null; // timeout — treat as "not found"
        }
        if (attempt < this.retries) {
          await sleep(200 * Math.pow(2, attempt));
          continue;
        }
        return null;
      } finally {
        clearTimeout(timer);
      }
    }

    return null;
  }

  /** Fetch a developer's profile + on-chain stats, or null if not found. */
  async getProfile(handle: Handle): Promise<ProfileResponse | null> {
    return this.query<ProfileResponse>('profile.byHandle', { handle });
  }

  /** List every curated handle in the registry. */
  async listHandles(): Promise<Handle[]> {
    return (await this.query<Handle[]>('profile.list', undefined)) ?? [];
  }
}

/** Promise-based setTimeout for retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if an error is an AbortError (from AbortController).
 * Works across modern browsers and Node.js 17+.
 */
function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException
      ? err.name === 'AbortError'
      : (err as Error)?.name === 'AbortError'
  );
}
