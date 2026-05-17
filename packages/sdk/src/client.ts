import type { Handle, PlaceholderProfile } from '@signet/types';

export interface SignetClientOptions {
  /** Base URL of the Signet API, e.g. https://api.signet.dev */
  baseUrl?: string;
}

/**
 * Stub client for the external Signet SDK.
 *
 * TODO(signet): implement real fetch calls against the public API
 * (profile lookup, contract list, attestation verification, "Verified by
 * Signet" badge data).
 */
export class SignetClient {
  private readonly baseUrl: string;

  constructor(options: SignetClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://api.signet.dev';
  }

  // TODO(signet): replace with a real network call.
  async getProfile(handle: Handle): Promise<PlaceholderProfile | null> {
    void this.baseUrl;
    void handle;
    return null;
  }
}
