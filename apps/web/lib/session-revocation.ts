import { logger } from './logger.ts';

/**
 * Targeted session revocation.
 *
 * Sessions are stateless HMACs (`auth.ts`), so nothing on the server needs to
 * be consulted to decide that a cookie is authentic. The only lever that
 * existed for taking one back was `SIGNET_SESSIONS_VALID_AFTER`, an epoch-ms
 * floor applied to *every* session: the response to one compromised wallet was
 * to sign out every user of the product, and "sign out my other devices" was
 * not expressible at all.
 *
 * This module adds the two narrower levers, backed by the shared store already
 * used for sign-in nonces:
 *
 *   - **address** — reject sessions for one address issued before a cut-off,
 *     optionally sparing one session id (that is "sign out my *other*
 *     devices").
 *   - **session** — reject exactly one session id, leaving the address's other
 *     sessions alone (that is what `POST /api/auth/logout` now does, so a
 *     cookie copied off a device before sign-out dies with it).
 *
 * ## Why this does not put a store read on every request
 *
 * The revocation list is *short* — it holds only entries younger than a
 * session lifetime, and only for addresses something actually happened to — so
 * instead of asking the store "is this session revoked?" per request, each
 * instance keeps the whole list in memory and refreshes it every
 * {@link REFRESH_MS} ms. The happy path is a `Map` lookup; the store is read at
 * most once per instance per refresh interval, whatever the request rate.
 *
 * The cost of that trade is propagation delay: an instance that did not
 * perform the revocation honours it within `REFRESH_MS` (writes are applied to
 * the writing instance's own snapshot immediately). Ten seconds to sign out a
 * stolen session is a different order of problem from a store round trip on
 * every authenticated request.
 *
 * ## Failure policy: fail closed, after a grace window
 *
 * If the shared store cannot be read, the last good snapshot keeps being used
 * for up to {@link MAX_STALE_MS}; past that, every session is treated as
 * revoked. Revocation is a security control, so an outage must not silently
 * become "nobody is revoked" — but a blip should not sign the world out
 * either, which is what the grace window buys. With no shared store configured
 * (the in-memory default) there is nothing to fail: see the note on
 * {@link MemoryRevocationStore}.
 */

/** How long a snapshot is served before the store is consulted again. */
export const REFRESH_MS = 10_000;

/** How long a snapshot may be served after refreshes start failing. */
export const MAX_STALE_MS = 60_000;

/** Redis hash holding the whole list, so one round trip reads all of it. */
const HASH_KEY = 'signet:revocations';

/** A revocation covering one address' sessions. */
export interface AddressRule {
  /** Sessions with `iat` below this epoch-ms are rejected. */
  before: number;
  /** Session id spared by the rule — "sign out my other devices". */
  except?: string;
  /** Epoch-ms after which the entry is meaningless and can be dropped. */
  expires: number;
}

/** A revocation covering exactly one session id. */
export interface SessionRule {
  expires: number;
}

/** Keys are `a:<address>` and `s:<session id>` — see `addressKey`/`sessionKey`. */
export type RevocationList = Map<string, AddressRule | SessionRule>;

const addressKey = (address: string): string => `a:${address}`;
const sessionKey = (sid: string): string => `s:${sid}`;

export interface RevocationStore {
  /**
   * Record `rule` under `key` until it expires. Throws when the write could
   * not be confirmed — a revocation that silently did not land is worse than a
   * visible failure.
   */
  put(key: string, rule: AddressRule | SessionRule): Promise<void>;
  /** The whole list, or `null` when it could not be read. */
  snapshot(): Promise<RevocationList | null>;
}

/**
 * Per-instance store, the default.
 *
 * Correct on a single long-lived server. On a multi-replica or serverless
 * deploy it is not: a revocation recorded by the instance serving the request
 * is invisible to the others, so set the Upstash variables there — exactly as
 * for the sign-in nonce store.
 */
export class MemoryRevocationStore implements RevocationStore {
  private rules: RevocationList = new Map();

  async put(key: string, rule: AddressRule | SessionRule): Promise<void> {
    this.rules.set(key, rule);
  }

  async snapshot(): Promise<RevocationList> {
    return prune(this.rules, (key) => this.rules.delete(key));
  }

  clear(): void {
    this.rules.clear();
  }
}

/**
 * Shared store backed by Upstash Redis over its REST API, matching
 * `nonce-store.ts` (no TCP socket, so it works in edge and serverless
 * runtimes).
 *
 * The list lives in one hash, so a refresh is a single `HGETALL` however many
 * entries it holds. Entries carry their own expiry rather than relying on
 * per-field TTLs (which Redis does not have): a refresh drops the expired ones
 * from the snapshot and deletes them from the hash, and every write re-arms a
 * TTL on the hash itself so an abandoned deployment does not leave the key
 * behind forever.
 */
export class UpstashRevocationStore implements RevocationStore {
  private readonly url: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
  }

  private async pipeline(commands: unknown[][]): Promise<Array<{ result?: unknown }>> {
    const res = await fetch(`${this.url}/pipeline`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(commands),
    });
    if (!res.ok) throw new Error(`upstash responded ${res.status}`);
    return (await res.json()) as Array<{ result?: unknown }>;
  }

  async put(key: string, rule: AddressRule | SessionRule): Promise<void> {
    const ttlMs = Math.max(1, rule.expires - Date.now());
    const replies = await this.pipeline([
      ['HSET', HASH_KEY, key, JSON.stringify(rule)],
      // `GT` keeps the longest-lived entry's TTL rather than shortening the
      // key to whatever the latest write needs.
      ['PEXPIRE', HASH_KEY, ttlMs, 'GT'],
    ]);
    // `HSET` replies with the number of fields created — 0 when overwriting an
    // existing rule, which is a legitimate outcome (a re-revocation).
    if (typeof replies[0]?.result !== 'number') {
      throw new Error('upstash did not confirm the revocation write');
    }
  }

  async snapshot(): Promise<RevocationList | null> {
    try {
      const [reply] = await this.pipeline([['HGETALL', HASH_KEY]]);
      // Upstash renders a hash as a flat [field, value, field, value…] array.
      const flat = reply?.result;
      if (!Array.isArray(flat)) return null;

      const rules: RevocationList = new Map();
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const rule = parseRule(flat[i + 1]);
        if (rule) rules.set(String(flat[i]), rule);
      }

      const expired: string[] = [];
      const live = prune(rules, (key) => expired.push(key));
      // Housekeeping only: the snapshot is already correct without it, so a
      // failure here must not fail the refresh.
      if (expired.length > 0) {
        void this.pipeline([['HDEL', HASH_KEY, ...expired]]).catch(() => {});
      }
      return live;
    } catch (err) {
      logger.error({ err: String(err) }, 'revocation.snapshotFailed');
      return null;
    }
  }
}

function parseRule(raw: unknown): AddressRule | SessionRule | null {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return null;
    const rule = parsed as AddressRule;
    return typeof rule.expires === 'number' ? rule : null;
  } catch {
    return null;
  }
}

/** The entries that have not expired, reporting each expired key to `onExpired`. */
function prune(rules: RevocationList, onExpired: (key: string) => void): RevocationList {
  const now = Date.now();
  const live: RevocationList = new Map();
  for (const [key, rule] of rules) {
    if (rule.expires <= now) onExpired(key);
    else live.set(key, rule);
  }
  return live;
}

// ── Store selection (mirrors `nonce-store.ts`) ───────────────────────────────

let store: RevocationStore = new MemoryRevocationStore();
let storeResolved = false;
let initPromise: Promise<void> | null = null;

export function setRevocationStore(s: RevocationStore): void {
  store = s;
  storeResolved = true; // an explicit store wins over env-based auto-detection
  invalidateCache();
}

function ensureStore(): Promise<void> {
  if (storeResolved) return Promise.resolve();
  if (!initPromise) {
    initPromise = (async () => {
      const url = process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (store instanceof MemoryRevocationStore && url && token) {
        store = new UpstashRevocationStore(url, token);
      }
      storeResolved = true;
    })();
  }
  return initPromise;
}

// ── Cached snapshot ──────────────────────────────────────────────────────────

let cached: RevocationList | null = null;
let cachedAt = 0;
let refreshing: Promise<void> | null = null;

function invalidateCache(): void {
  cached = null;
  cachedAt = 0;
}

/**
 * The current list, or `null` when it cannot be established (see the failure
 * policy above). Concurrent callers share one refresh.
 */
async function revocations(): Promise<RevocationList | null> {
  await ensureStore();
  if (cached && Date.now() - cachedAt < REFRESH_MS) return cached;

  if (!refreshing) {
    const inflight: Promise<void> = store
      .snapshot()
      .then((next) => {
        if (!next) return;
        cached = next;
        cachedAt = Date.now();
      })
      .catch((err: unknown) => {
        logger.error({ err: String(err) }, 'revocation.refreshFailed');
      })
      .finally(() => {
        if (refreshing === inflight) refreshing = null;
      });
    refreshing = inflight;
  }
  await refreshing;

  if (!cached) return null;
  const staleMs = Date.now() - cachedAt;
  if (staleMs > MAX_STALE_MS) {
    logger.error({ staleMs }, 'revocation.snapshotTooStale');
    return null;
  }
  return cached;
}

/** Apply a write to this instance's snapshot so it takes effect immediately. */
function applyLocally(key: string, rule: AddressRule | SessionRule): void {
  if (cached) cached.set(key, rule);
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface SessionClaims {
  address: string;
  /** Session id; absent on sessions issued before session ids existed. */
  sid?: string;
  /** Issued-at, epoch-ms. */
  iat: number;
  /** Expiry, epoch-ms — bounds how long a revocation entry has to be kept. */
  exp: number;
}

/**
 * Revoke sessions for one address issued before `before` — by default every
 * session that exists at the moment of the call — optionally sparing
 * `exceptSid`.
 *
 * `until` is when the entry may be forgotten: it has to outlive the longest
 * session the rule could still reject, which callers derive from the session
 * lifetime.
 */
export async function revokeAddress(
  address: string,
  opts: { before?: number; exceptSid?: string; until: number },
): Promise<void> {
  await ensureStore();
  const rule: AddressRule = {
    // `+ 1` because the cut-off is exclusive and `iat` has millisecond
    // resolution: a session minted in this same millisecond is one that
    // already exists, so "revoke everything now" has to cover it.
    before: opts.before ?? Date.now() + 1,
    ...(opts.exceptSid ? { except: opts.exceptSid } : {}),
    expires: opts.until,
  };
  const key = addressKey(address);
  await store.put(key, rule);
  applyLocally(key, rule);
  logger.info({ address, before: rule.before, spared: rule.except ?? null }, 'auth.addressRevoked');
}

/** Revoke exactly one session, until `until` (its own expiry). */
export async function revokeSession(sid: string, until: number): Promise<void> {
  await ensureStore();
  const rule: SessionRule = { expires: until };
  const key = sessionKey(sid);
  await store.put(key, rule);
  applyLocally(key, rule);
  logger.info({ sid }, 'auth.sessionRevoked');
}

/**
 * Whether `claims` names a revoked session. Returns `true` when the list
 * cannot be established — see the failure policy above.
 */
export async function isRevoked(claims: SessionClaims): Promise<boolean> {
  const rules = await revocations();
  if (!rules) return true;
  if (rules.size === 0) return false; // the overwhelmingly common case

  if (claims.sid && rules.has(sessionKey(claims.sid))) return true;

  const rule = rules.get(addressKey(claims.address)) as AddressRule | undefined;
  if (!rule) return false;
  // A session issued before the cut-off is revoked unless it is the one the
  // rule spares. Sessions predating session ids have nothing to spare, so any
  // address rule covers them — the safe direction.
  return claims.iat < rule.before && (!claims.sid || rule.except !== claims.sid);
}

/** Test-only: fresh in-memory store, empty cache, auto-detection re-enabled. */
export function __resetRevocationStore(): void {
  if (store instanceof MemoryRevocationStore) store.clear();
  else store = new MemoryRevocationStore();
  storeResolved = false;
  initPromise = null;
  invalidateCache();
}
