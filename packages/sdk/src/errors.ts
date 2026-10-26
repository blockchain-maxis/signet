/**
 * Typed SDK errors, so callers can distinguish "not found" from "network down"
 * from a server error instead of catching a bare `Error`. All extend
 * `SignetError`, so `catch (e) { if (e instanceof SignetError) … }` matches any.
 *
 * Every error the server answered with carries its HTTP `status` and the v1
 * envelope's `code` (`not_found`, `bad_request`, `rate_limited`, …) when the
 * body had one.
 */

export class SignetError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    // Preserve the concrete subclass name across the prototype chain.
    this.name = new.target.name;
  }
}

/** What the server's error envelope said, passed to each error's constructor. */
export interface ServerErrorOptions extends ErrorOptions {
  code?: string;
}

/** The requested resource does not exist (HTTP 404). */
export class NotFoundError extends SignetError {
  readonly status = 404 as const;
  readonly code: string | undefined;
  constructor(message = 'Resource not found', options?: ServerErrorOptions) {
    super(message, options);
    this.code = options?.code;
  }
}

/** The request was malformed: a bad handle, address, cursor or limit (HTTP 400). */
export class ValidationError extends SignetError {
  readonly status = 400 as const;
  readonly code: string | undefined;
  /** The parameter the server rejected, when it said which. */
  readonly parameter: string | undefined;
  constructor(message = 'Invalid request', options?: ServerErrorOptions & { parameter?: string }) {
    super(message, options);
    this.code = options?.code;
    this.parameter = options?.parameter;
  }
}

/**
 * Over the deployment's rate limit (HTTP 429). `retryAfterSeconds` is the
 * server's `Retry-After`, or null when it sent none. The client has already
 * waited and retried when the wait was 5 seconds or less; this surfaces when
 * the wait is longer, or the retries ran out.
 */
export class RateLimitedError extends SignetError {
  readonly status = 429 as const;
  readonly code: string | undefined;
  readonly retryAfterSeconds: number | null;
  constructor(
    message = 'Rate limited',
    options?: ServerErrorOptions & { retryAfterSeconds?: number | null },
  ) {
    super(message, options);
    this.code = options?.code;
    this.retryAfterSeconds = options?.retryAfterSeconds ?? null;
  }
}

/**
 * The deployment could not answer right now (HTTP 503): no layer it reads
 * (database, registry, Horizon) was reachable. Retried before it surfaces.
 */
export class UnavailableError extends SignetError {
  readonly status = 503 as const;
  readonly code: string | undefined;
  constructor(message = 'Service unavailable', options?: ServerErrorOptions) {
    super(message, options);
    this.code = options?.code;
  }
}

/** The request never reached the server (offline, DNS/TLS failure, timeout). */
export class NetworkError extends SignetError {
  constructor(message = 'Network request failed', options?: ErrorOptions) {
    super(message, options);
  }
}

/** Any other non-OK status. Carries that `status`, and the envelope's `code`. */
export class ApiError extends SignetError {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, options?: ServerErrorOptions) {
    super(message, options);
    this.status = status;
    this.code = options?.code;
  }
}
