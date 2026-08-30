/**
 * HTTP client for the Signet device-linking endpoints that back `signet link`.
 *
 * Every request is bounded with an `AbortController` so a stalled or
 * unreachable server can never turn the carefully bounded wait loop into a
 * hang — the network itself fails fast, and the caller routes that into a clear
 * error rather than a silent wait.
 */

/** Response from a successful `POST /api/link/device`. */
export interface DevicePair {
  /** Human-facing pairing code shown on the terminal. */
  pairingCode: string;
  /** Absolute URL a developer opens in a browser to approve the link. */
  verificationUrl: string;
  /** How long the pairing stays valid — the CLI waits this long, no more. */
  ttlMs: number;
  /** How often to poll `statusCode`, from the server. */
  intervalMs: number;
}

/** The states a pairing reports while a CLI waits. */
export type LinkState = 'pending' | 'approved' | 'rejected' | 'expired';

export interface LinkStatus {
  state: LinkState;
}

export class SignetLinkError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SignetLinkError';
    this.status = status;
  }
}

export interface LinkClientOptions {
  /** Optional fetch implementation (for tests). */
  fetch?: typeof fetch;
  /** Per-request timeout in ms (default 10s). Bounds a stalled socket. */
  timeoutMs?: number;
}

export class LinkClient {
  private readonly _baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, options: LinkClientOptions = {}) {
    this._baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!this.fetchImpl) {
      throw new SignetLinkError('no fetch implementation available; pass options.fetch', 0);
    }
  }

  /** Base URL without a trailing slash, ready for retry instructions. */
  get baseUrl(): string {
    return this._baseUrl;
  }

  /** Start a linking session: ask the server for a pairing code + verification URL. */
  async createDevice(): Promise<DevicePair> {
    const res = await this.request(`${this._baseUrl}/api/link/device`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    return (await res.json()) as DevicePair;
  }

  /** Ask whether the browser has approved the linking session. */
  async getStatus(pairingCode: string): Promise<LinkStatus> {
    const res = await this.request(
      `${this._baseUrl}/api/link/device/status?code=${encodeURIComponent(pairingCode)}`,
      { method: 'GET', headers: { accept: 'application/json' } },
    );
    return (await res.json()) as LinkStatus;
  }

  /** A bounded fetch: never lets a stalled server block the wait loop. */
  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { ...init, signal: controller.signal });
      } catch (cause) {
        const aborted = cause instanceof Error && cause.name === 'AbortError';
        throw new SignetLinkError(
          aborted
            ? `request to ${url} timed out after ${this.timeoutMs}ms`
            : `request to ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          0,
        );
      }
      if (!res.ok) {
        throw new SignetLinkError(`request to ${url} failed with status ${res.status}`, res.status);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
}