import { isValidHandle } from '@signet/types';
import { verifyApiKey, type ApiKeyStore } from '../../api-keys.ts';
import { logger } from '../../logger.ts';
import { rateLimit } from '../../rate-limit.ts';
import { LIMITS, WINDOW_MS, type RateLimitBucket } from '../../rate-limit-policy.ts';
import { clientIp } from '../../security.ts';
import { isValidStellarAddress, STELLAR_ADDR_RE } from '../../stellar-address.ts';

export type V1ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'unavailable'
  | 'internal';

export const HTTP_STATUS_BY_CODE: Record<V1ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

export class V1Error extends Error {
  readonly code: V1ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: V1ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'V1Error';
    this.code = code;
    this.details = details;
  }
}

export function isV1Error(err: unknown): err is V1Error {
  return err instanceof V1Error;
}

export interface V1SuccessEnvelope<T, M = Record<string, unknown>> {
  data: T;
  meta?: M;
}

export interface V1ErrorEnvelope {
  error: {
    code: V1ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Returns a standardized JSON success response.
 *
 * Success envelope: `{ "data": T, "meta"?: M }`
 */
export function ok<T, M = Record<string, unknown>>(
  data: T,
  meta?: M,
  init?: ResponseInit,
): Response {
  const status = init?.status ?? 200;
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
  }

  const body: V1SuccessEnvelope<T, M> = {
    data,
    ...(meta !== undefined ? { meta } : {}),
  };

  return new Response(JSON.stringify(body), {
    status,
    statusText: init?.statusText,
    headers,
  });
}

/**
 * Returns a standardized JSON error response.
 *
 * Error envelope: `{ "error": { "code": ..., "message": ..., "details"?: ... } }`
 */
export function fail(
  code: V1ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  init?: ResponseInit,
): Response {
  const status = init?.status ?? HTTP_STATUS_BY_CODE[code] ?? 500;
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
  }

  const body: V1ErrorEnvelope = {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };

  return new Response(JSON.stringify(body), {
    status,
    statusText: init?.statusText,
    headers,
  });
}

export interface WithV1Options {
  bucket?: RateLimitBucket;
  cache?: string;
  apiKeyStore?: ApiKeyStore;
}

export type V1Handler = (req: Request) => Promise<Response> | Response;

/**
 * Wraps a v1 route handler with:
 * - OPTIONS preflight handling (`Access-Control-Allow-*`)
 * - CORS headers (`Access-Control-Allow-Origin: *` on GET, HEAD, OPTIONS)
 * - 405 Method Not Allowed handling for mutating methods
 * - Optional API key authentication for elevated rate limits (sgk_ keys)
 * - Rate-limit enforcement and `RateLimit-*` headers on every response
 * - Retry-After on 429
 * - Safe error mapping to `{ error: { code: 'internal' } }` with no stack traces
 */
export function withV1(
  handler: V1Handler,
  options: WithV1Options = {},
): (req: Request) => Promise<Response> {
  const bucket: RateLimitBucket = options.bucket ?? 'v1Read';
  const cacheHeader = options.cache;

  return async function handle(req: Request): Promise<Response> {
    const method = req.method.toUpperCase();

    // 1. Mutating endpoints rejection (docs/API_V1.md §CORS)
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      return fail('bad_request', 'Method not allowed. v1 endpoints are read-only.', undefined, {
        status: 405,
        headers: {
          Allow: 'GET, HEAD, OPTIONS',
          'Cache-Control': 'no-store',
        },
      });
    }

    // 2. OPTIONS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-None-Match',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // 3. API key authentication and rate limiting
    const authHeader = req.headers.get('Authorization');
    let rateKey: string;
    let limit: number;

    if (authHeader) {
      if (!authHeader.startsWith('Bearer ')) {
        const response = fail('unauthorized', 'Invalid Authorization header format.', undefined, {
          status: 401,
          headers: { 'Cache-Control': 'no-store' },
        });
        applyCorsAndRateHeaders(response.headers, {});
        return response;
      }

      const token = authHeader.slice(7).trim();
      const verifyResult = await verifyApiKey(token, options.apiKeyStore);
      if (!verifyResult.ok) {
        const response = fail('unauthorized', verifyResult.reason, undefined, {
          status: 401,
          headers: { 'Cache-Control': 'no-store' },
        });
        applyCorsAndRateHeaders(response.headers, {});
        return response;
      }

      rateKey = `v1:key:${verifyResult.record.id}`;
      limit = LIMITS.v1Keyed;
    } else {
      const ip = clientIp(req.headers);
      limit = LIMITS[bucket] ?? 60;
      rateKey = `v1:${bucket}:${ip}`;
    }

    const rateResult = await rateLimit(rateKey, limit, WINDOW_MS);

    const resetSeconds = Math.max(1, Math.ceil(rateResult.resetMs / 1000));
    const rateLimitHeaders: Record<string, string> = {
      'RateLimit-Limit': String(limit),
      'RateLimit-Remaining': String(rateResult.remaining),
      'RateLimit-Reset': String(resetSeconds),
    };

    if (!rateResult.ok) {
      const response = fail(
        'rate_limited',
        `Too many requests. Retry in ${resetSeconds} seconds.`,
        { retryAfter: resetSeconds },
        {
          status: 429,
          headers: {
            'Retry-After': String(resetSeconds),
            'Cache-Control': 'no-store',
          },
        },
      );
      applyCorsAndRateHeaders(response.headers, rateLimitHeaders);
      return response;
    }

    // 4. Execute handler with error trapping
    let response: Response;
    try {
      response = await handler(req);
    } catch (err: unknown) {
      if (err instanceof V1Error) {
        response = fail(err.code, err.message, err.details);
      } else {
        logger.error({ err, path: req.url }, 'v1.internal_error');
        response = fail('internal', 'Something went wrong. Try again later.');
      }
    }

    // 5. Apply CORS, RateLimit, and Caching headers
    applyCorsAndRateHeaders(response.headers, rateLimitHeaders);

    if (response.status >= 400) {
      if (!response.headers.has('Cache-Control')) {
        response.headers.set('Cache-Control', 'no-store');
      }
    } else if (cacheHeader && !response.headers.has('Cache-Control')) {
      response.headers.set('Cache-Control', cacheHeader);
    }

    return response;
  };
}

function applyCorsAndRateHeaders(headers: Headers, rateHeaders: Record<string, string>): void {
  headers.set('Access-Control-Allow-Origin', '*');
  for (const [k, v] of Object.entries(rateHeaders)) {
    headers.set(k, v);
  }
}

/**
 * Validates and normalizes a handle parameter.
 * Normalizes to lowercase and asserts validity against @signet/types isValidHandle.
 */
export function parseHandle(raw: unknown): string {
  const handle = String(raw ?? '').trim().toLowerCase();
  if (!handle || !isValidHandle(handle)) {
    throw new V1Error('bad_request', `Invalid handle "${handle}".`, { parameter: 'handle' });
  }
  return handle;
}

/**
 * Validates a Stellar public key ('G') or contract ID ('C').
 */
export function parseAddress(raw: unknown, kind?: 'G' | 'C'): string {
  const address = String(raw ?? '').trim();
  const valid = kind
    ? isValidStellarAddress(address, kind)
    : STELLAR_ADDR_RE.test(address);

  if (!valid) {
    const desc =
      kind === 'G'
        ? 'G… account address'
        : kind === 'C'
          ? 'C… contract ID'
          : 'Stellar address (G… or C…)';
    throw new V1Error('bad_request', `Invalid ${desc} "${address}".`, { parameter: 'address' });
  }
  return address;
}

/**
 * Parses a numeric pagination limit, defaulting to 25 with a maximum of 100.
 */
export function parseLimit(raw: unknown, defaultLimit = 25, maxLimit = 100): number {
  if (raw === undefined || raw === null || raw === '') {
    return defaultLimit;
  }
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 1 || num > maxLimit) {
    throw new V1Error('bad_request', `limit must be between 1 and ${maxLimit}.`, {
      parameter: 'limit',
      max: maxLimit,
    });
  }
  return num;
}

/**
 * Encodes an arbitrary cursor payload into an opaque base64url string with a version prefix byte.
 */
export function encodeCursor<T>(payload: T, version = 1): string {
  const jsonStr = JSON.stringify(payload);
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  const buf = Buffer.alloc(1 + jsonBuf.length);
  buf.writeUInt8(version, 0);
  jsonBuf.copy(buf, 1);
  return buf.toString('base64url');
}

/**
 * Decodes an opaque base64url cursor, checking the version prefix byte.
 */
export function parseCursor<T = unknown>(raw: unknown, expectedVersion = 1): T | null {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new V1Error('bad_request', 'Invalid cursor format.', { parameter: 'cursor' });
  }
  try {
    const buf = Buffer.from(raw, 'base64url');
    if (buf.length < 1) {
      throw new Error('empty cursor buffer');
    }
    const version = buf.readUInt8(0);
    if (version !== expectedVersion) {
      throw new Error(`unsupported cursor version: ${version}`);
    }
    const jsonStr = buf.subarray(1).toString('utf8');
    return JSON.parse(jsonStr) as T;
  } catch {
    throw new V1Error('bad_request', 'Invalid or unparseable pagination cursor.', {
      parameter: 'cursor',
    });
  }
}
