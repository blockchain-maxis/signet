/**
 * Typed SDK errors, so callers can distinguish "not found" from "network down"
 * from a server error instead of catching a bare `Error`. All extend
 * `SignetError`, so `catch (e) { if (e instanceof SignetError) … }` matches any.
 */

export class SignetError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    // Preserve the concrete subclass name across the prototype chain.
    this.name = new.target.name;
  }
}

/** The requested resource does not exist (HTTP 404). */
export class NotFoundError extends SignetError {
  readonly status = 404 as const;
  constructor(message = 'Resource not found', options?: ErrorOptions) {
    super(message, options);
  }
}

/** The request never reached the server (offline, DNS/TLS failure, timeout). */
export class NetworkError extends SignetError {
  constructor(message = 'Network request failed', options?: ErrorOptions) {
    super(message, options);
  }
}

/** The server responded with a non-OK, non-404 status. Carries that `status`. */
export class ApiError extends SignetError {
  readonly status: number;
  constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}
