import type { Handle, ProfileResponse } from '@signet/types';

export interface SignetClientOptions {
  /** Base URL of a Signet deployment, e.g. https://signet.dev */
  baseUrl?: string;
  /** Optional fetch implementation (for tests / non-browser runtimes). */
  fetch?: typeof fetch;
  /**
   * Request timeout in milliseconds. When set, the client will abort a
   * request if the server does not respond within this window.
   * @default 10_000 (10 seconds)
   */
  timeoutMs?: number;
  /**
   * Maximum number of retry attempts for responses with status 5xx.
   * Retries use an exponential backoff: 200ms, 400ms, 800ms, …
   * @default 2
   */
  maxRetries?: number;
}

/**
 * Public SDK client for the Signet API.
 *
 * Talks to the tRPC endpoint over its HTTP GET form
 * (`/api/trpc/{procedure}?input=…`) so external integrators don't need the
 * tRPC client library.
 */
export class SignetClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: SignetClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://signet.dev').replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    if (!this.fetchImpl) {
      throw new Error('[signet] no fetch implementation available; pass options.fetch');
    }
  }

  private async query<T>(procedure: string, input: unknown): Promise<T | null> {
    const url = `${this.baseUrl}/api/trpc/${procedure}?input=${encodeURIComponent(
      JSON.stringify(input),
    )}`;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await this.fetchImpl(url, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });

        if (!res.ok) {
          // Retry on server errors (5xx), up to maxRetries
          if (res.status >= 500 && res.status < 600 && attempt < this.maxRetries) {
            clearTimeout(timer);
            await this.backoff(attempt);
            continue;
          }
          return null;
        }

        const body = (await res.json()) as { result?: { data?: T } };
        return body.result?.data ?? null;
      } catch (err: unknown) {
        // AbortError (timeout) or network error – retry if attempts remain
        if (attempt < this.maxRetries && this.isRetryableError(err)) {
          clearTimeout(timer);
          await this.backoff(attempt);
          continue;
        }
        return null;
      } finally {
        clearTimeout(timer);
      }
    }

    return null;
  }

  /** Exponential backoff: 200ms, 400ms, 800ms, … */
  private async backoff(attempt: number): Promise<void> {
    const delay = Math.min(200 * Math.pow(2, attempt), 5_000);
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  /** Returns true for AbortError / network errors that are safe to retry. */
  private isRetryableError(err: unknown): boolean {
    if (err instanceof DOMException && err.name === 'AbortError') return true;
    if (err instanceof TypeError) return true; // network errors
    return false;
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
