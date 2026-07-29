import { logger } from './logger.js';

export interface RetryOptions {
  /** Maximum number of attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in ms between retries (default: 30_000) */
  maxDelayMs?: number;
  /** Context label for structured logging (default: 'retry') */
  label?: string;
}

const DEFAULT_OPTS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  label: 'retry',
};

/**
 * Determine whether an error from the Stellar SDK / Horizon is transient
 * and worth retrying.
 *
 * Transient conditions:
 *  - HTTP 429 Too Many Requests
 *  - HTTP 5xx Server Errors
 *  - Network-level errors (fetch failures, DNS, connection refused, etc.)
 */
export function isTransientError(err: unknown): boolean {
  const msg = String(err);

  // Horizon errors from the SDK typically include the status code in the message
  if (/status\s*[=:]\s*429/i.test(msg)) return true;
  if (/429/i.test(msg)) return true;
  if (/5\d{2}/.test(msg)) return true;

  // Network-level errors
  if (/fetch\s+failed/i.test(msg)) return true;
  if (/network/i.test(msg) && /error/i.test(msg)) return true;
  if (/econnrefused/i.test(msg)) return true;
  if (/etimedout/i.test(msg)) return true;
  if (/econnreset/i.test(msg)) return true;
  if (/dns\s+resolution/i.test(msg)) return true;
  if (/request\s+failed/i.test(msg)) return true;
  if (/socket\s+hang/i.test(msg)) return true;
  if (/socket.*timeout/i.test(msg)) return true;
  if (/aborted/i.test(msg)) return true;
  if (/timeout/i.test(msg) && /exceeded/i.test(msg)) return true;

  // Stellar SDK-specific network error signals
  if (/connection/i.test(msg) && /refused/i.test(msg)) return true;
  if (/connect\s+etimedout/i.test(msg)) return true;

  return false;
}

/**
 * Compute the delay before the next retry attempt using exponential backoff
 * with full jitter (randomised between 0 and the calculated backoff).
 *
 * Formula: sleep = random(0, min(maxDelay, baseDelay * 2^attempt))
 */
export function calculateBackoff(
  attempt: number,
  baseDelayMs: number = DEFAULT_OPTS.baseDelayMs,
  maxDelayMs: number = DEFAULT_OPTS.maxDelayMs,
): number {
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxDelayMs);
  return Math.round(Math.random() * capped);
}

/**
 * Wrap an async function with exponential-backoff retry logic.
 *
 * Only transient errors (429, 5xx, network failures) trigger a retry.
 * Non-transient errors are immediately re-thrown.
 * Exhausts all attempts then throws the last encountered error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const opts: Required<RetryOptions> = { ...DEFAULT_OPTS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Non-transient errors are fatal — no retry
      if (!isTransientError(err)) {
        throw err;
      }

      // Last attempt exhausted — log the failure context and throw
      if (attempt === opts.maxAttempts) {
        logger.error(
          {
            label: opts.label,
            attempt,
            maxAttempts: opts.maxAttempts,
            error: String(err),
            errorType: err instanceof Error ? err.constructor.name : typeof err,
          },
          'retry.exhausted',
        );
        throw err;
      }

      const delay = calculateBackoff(attempt, opts.baseDelayMs, opts.maxDelayMs);
      logger.warn(
        {
          label: opts.label,
          attempt,
          maxAttempts: opts.maxAttempts,
          delayMs: delay,
          error: String(err),
        },
        'retry.scheduled',
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Should never reach here, but satisfies TypeScript
  throw lastError;
}
