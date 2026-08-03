import type { Handle, ProfileResponse, RegistryEntry, RegistryCount } from '@signet/types';
import { ApiError, NetworkError, NotFoundError } from './errors.ts';

export interface SignetClientOptions {
  /** Base URL of a Signet deployment, e.g. https://signet.dev */
  baseUrl?: string;
  /** Optional fetch implementation (for tests / non-browser runtimes). */
  fetch?: typeof fetch;
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

  constructor(options: SignetClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://signet.dev').replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error('[signet] no fetch implementation available; pass options.fetch');
    }
  }

  /**
   * Issues a tRPC GET query. Throws a typed error the caller can discriminate:
   * `NetworkError` when the request never reached the server, `NotFoundError`
   * on a 404, or `ApiError` (carrying the status) on any other non-OK response.
   */
  private async query<T>(procedure: string, input: unknown): Promise<T | null> {
    const url = `${this.baseUrl}/api/trpc/${procedure}?input=${encodeURIComponent(
      JSON.stringify(input),
    )}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    } catch (cause) {
      throw new NetworkError(`request to ${procedure} failed`, { cause });
    }

    if (!res.ok) {
      if (res.status === 404) throw new NotFoundError(`${procedure} not found`);
      throw new ApiError(`${procedure} failed with status ${res.status}`, res.status);
    }

    const body = (await res.json()) as { result?: { data?: T } };
    return body.result?.data ?? null;
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

  /** Return the total number of registered handle ↔ wallet bindings. */
  async countRegistryEntries(): Promise<RegistryCount> {
    return (await this.query<RegistryCount>('registry.count', undefined)) ?? { count: 0 };
  }
}
