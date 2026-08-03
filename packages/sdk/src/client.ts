import type { Handle, ProfileResponse, RegistryEntry, RegistryCount } from '@signet/types';

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

  private async query<T>(procedure: string, input: unknown): Promise<T | null> {
    const url = `${this.baseUrl}/api/trpc/${procedure}?input=${encodeURIComponent(
      JSON.stringify(input),
    )}`;
    const res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { data?: T } };
    return body.result?.data ?? null;
  }

  /** Fetch a developer's profile + on-chain stats, or null if not found. */
  async getProfile(handle: Handle): Promise<ProfileResponse | null> {
    return this.query<ProfileResponse>('profile.byHandle', { handle });
  }

  /** List every curated handle in the registry. */
  async listHandles(): Promise<Handle[]> {
    return (await this.query<Handle[]>('profile.list', undefined)) ?? [];
  }

  /** Resolve a handle to its bound wallet address, or null if unregistered. */
  async resolveHandle(handle: Handle): Promise<RegistryEntry | null> {
    return this.query<RegistryEntry>('registry.resolve', { handle });
  }

  /** Reverse-lookup: find the handle bound to a wallet address. */
  async lookupWallet(wallet: string): Promise<RegistryEntry | null> {
    return this.query<RegistryEntry>('registry.lookup', { wallet });
  }

  /** Return the total number of registered handle ↔ wallet bindings. */
  async countRegistryEntries(): Promise<RegistryCount> {
    return (await this.query<RegistryCount>('registry.count', undefined)) ?? { count: 0 };
  }
}
