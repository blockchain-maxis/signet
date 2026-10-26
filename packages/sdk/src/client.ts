import type { Handle, ProfileResponse, RegistryCount, RegistryEntry, V1Data } from './types.ts';
import {
  ApiError,
  NetworkError,
  NotFoundError,
  RateLimitedError,
  UnavailableError,
  ValidationError,
} from './errors.ts';

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
   * backoff (200ms, 400ms, 800ms …, capped at 5s), and a 429 whose
   * `Retry-After` is 5 seconds or less, after that wait. A 404 and any other
   * 4xx are answers, not glitches, so they are never retried. Set to 0 to
   * disable.
   */
  maxRetries?: number;
  /**
   * A Signet API key (`sgk_…`), sent as `Authorization: Bearer`, for the
   * higher keyed rate limit. Keep it server-side: anyone who can read it can
   * spend its budget.
   */
  apiKey?: string;
}

/** Per-attempt timeout, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Retries after the initial attempt. */
const DEFAULT_MAX_RETRIES = 2;
/** Ceiling on a single backoff delay, in milliseconds. */
const MAX_BACKOFF_MS = 5_000;
/** The longest `Retry-After` the client waits out by itself, in seconds. */
const MAX_AUTO_RETRY_AFTER_S = 5;

/** An `AbortController`-aborted fetch, across browsers and Node 17+. */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** `Retry-After` in seconds: delta-seconds or an HTTP date; null when absent or unreadable. */
function retryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/** A v1 success body: `{ data, meta? }`. */
export interface V1Envelope<T, M = Record<string, unknown>> {
  data: T;
  meta?: M;
}

interface V1ErrorBody {
  error?: { code?: string; message?: string; details?: { parameter?: string } };
}

export interface RequestOptions {
  /** Query parameters; undefined and null values are left out. */
  query?: Record<string, string | number | undefined | null>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Public SDK client for the Signet API.
 *
 * Talks to the versioned REST API under `/api/v1` (see `docs/API_V1.md`),
 * whose responses are `{ data, meta? }` and whose errors are
 * `{ error: { code, message } }`, mapped to the typed errors in `./errors.ts`.
 *
 * Every request is bounded by `timeoutMs` and retried up to `maxRetries` times
 * on 5xx / network failures — see `SignetClientOptions` for the defaults.
 */
export class SignetClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly apiKey: string | undefined;

  constructor(options: SignetClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.apiKey = options.apiKey;
    if (!this.fetchImpl) {
      throw new Error('[signet] no fetch implementation available; pass options.fetch');
    }
  }

  /** Exponential backoff between attempts: 200ms, 400ms, 800ms …, capped. */
  private backoff(attempt: number): Promise<void> {
    return sleep(Math.min(200 * 2 ** attempt, MAX_BACKOFF_MS));
  }

  /**
   * GETs a path under the deployment and returns the response, retrying
   * transient failures; the error that surfaces is the final attempt's.
   * `NetworkError` when the request never reached the server (including a
   * timeout); otherwise the typed error for the status (see `toError`).
   */
  private async send<T>(path: string, label: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    for (let attempt = 0; ; attempt++) {
      const retriesLeft = attempt < this.maxRetries;
      const controller = new AbortController();
      // The timer covers reading the body too, not just the response headers —
      // a server that streams one byte an hour is as stalled as a dead socket.
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        let res: Response;
        try {
          res = await this.fetchImpl(url, { headers, signal: controller.signal });
        } catch (cause) {
          if (retriesLeft) {
            await this.backoff(attempt);
            continue;
          }
          throw new NetworkError(
            isAbortError(cause)
              ? `request to ${label} timed out after ${this.timeoutMs}ms`
              : `request to ${label} failed`,
            { cause },
          );
        }

        if (!res.ok) {
          const err = await this.toError(res, label);
          if (err instanceof RateLimitedError) {
            const wait = err.retryAfterSeconds;
            if (retriesLeft && wait !== null && wait <= MAX_AUTO_RETRY_AFTER_S) {
              clearTimeout(timer);
              await sleep(wait * 1000);
              continue;
            }
          } else if (res.status >= 500 && retriesLeft) {
            await this.backoff(attempt);
            continue;
          }
          throw err;
        }
        return (await res.json()) as T;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** The typed error for a non-OK response, from its status and v1 error envelope. */
  private async toError(res: Response, label: string): Promise<Error> {
    let body: V1ErrorBody = {};
    try {
      body = ((await res.json()) as V1ErrorBody) ?? {};
    } catch {
      // Not JSON (a proxy's error page): the status alone decides.
    }
    const code = body.error?.code;
    const message = body.error?.message ?? `${label} failed with status ${res.status}`;
    switch (res.status) {
      case 400:
        return new ValidationError(message, { code, parameter: body.error?.details?.parameter });
      case 404:
        return new NotFoundError(message, { code });
      case 429:
        return new RateLimitedError(message, {
          code,
          retryAfterSeconds: retryAfterSeconds(res.headers?.get('retry-after') ?? null),
        });
      case 503:
        return new UnavailableError(message, { code });
      default:
        return new ApiError(message, res.status, { code });
    }
  }

  /**
   * GETs a v1 endpoint (`path` is relative to `/api/v1`) and returns its
   * `{ data, meta }` envelope. Throws the typed error for anything else.
   */
  async request<T, M = Record<string, unknown>>(
    path: string,
    options: RequestOptions = {},
  ): Promise<V1Envelope<T, M>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    const qs = params.toString() ? `?${params}` : '';
    return this.send<V1Envelope<T, M>>(`/api/v1${path}${qs}`, path);
  }

  /** As `request`, but a 404 is the answer `null`; every other error still throws. */
  private async dataOrNull<T>(path: string): Promise<T | null> {
    try {
      return (await this.request<T>(path)).data;
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  /**
   * A developer's profile (`GET /api/v1/profiles/{handle}`), or `null` when
   * there is no such handle. Other failures (network down, server error)
   * throw the corresponding typed error.
   */
  async getProfile(handle: Handle): Promise<ProfileResponse | null> {
    return this.dataOrNull<ProfileResponse>(`/profiles/${encodeURIComponent(handle)}`);
  }

  /**
   * Every handle the deployment can serve.
   *
   * @deprecated v1 has no endpoint that lists handles, so this still calls the
   * internal tRPC route `profile.list`, which is not a stable contract. It will
   * be removed in 1.0.
   */
  async listHandles(): Promise<Handle[]> {
    const body = await this.send<{ result?: { data?: Handle[] | null } }>(
      '/api/trpc/profile.list',
      'profile.list',
    );
    return body.result?.data ?? [];
  }

  /**
   * Resolve a handle to its on-chain bound wallet (`GET /api/v1/resolve/{handle}`),
   * or null if the handle is not bound.
   */
  async resolveHandle(handle: Handle): Promise<RegistryEntry | null> {
    const data = await this.dataOrNull<V1Data<'resolveHandle'>>(
      `/resolve/${encodeURIComponent(handle)}`,
    );
    return data ? { handle: data.handle, wallet: data.wallet } : null;
  }

  /**
   * Reverse lookup (`GET /api/v1/lookup/{address}`): the handle a `G…` wallet is
   * attributed to, whether bound on chain or linked from the CLI, or null when
   * it is not linked.
   */
  async lookupWallet(wallet: string): Promise<RegistryEntry | null> {
    const { data } = await this.request<V1Data<'lookupWallet'>>(
      `/lookup/${encodeURIComponent(wallet)}`,
    );
    return data.handle ? { handle: data.handle, wallet: data.address } : null;
  }

  /**
   * The registry's own binding counter (`boundHandles` of
   * `GET /api/v1/registry/stats`) — an upper bound, not a live total: a binding
   * that lapses from on-chain storage unaccessed is never subtracted. Resolve a
   * specific handle to prove a binding is live. When the registry could not be
   * read the count is 0.
   */
  async countRegistryEntries(): Promise<RegistryCount> {
    const { data } = await this.request<V1Data<'getRegistryStats'>>('/registry/stats');
    return { count: data.boundHandles ?? 0 };
  }
}
