import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  ALLOW_HTTP,
  REGISTRY_CONTRACT_ID,
  SOROBAN_RPC_URL,
  isRegistryConfigured,
} from './chain.ts';
import { isValidHandle, listHandles as listCuratedHandles } from './profiles.ts';
import { boundCount, resolveHandle, type RegistryReadOptions } from './server/registry-read.ts';

/**
 * Public handle directory (powers `/handles`).
 *
 * Two different reads, for two different jobs:
 *
 *   1. **Discovery** — which handles might be bound at all. Two sources, in
 *      preference order:
 *
 *      - `fetchIndexedDirectory` reads the indexer's Postgres tables, which
 *        the attestation worker (apps/indexer/src/workers/attestation.ts)
 *        keeps current from the same event stream *with a persisted cursor*.
 *        That cursor is the whole point: the worker accumulates bindings
 *        across ticks, so the database remembers claims from any point in the
 *        registry's history, not just recent ones.
 *      - `fetchLiveDirectory` reconstructs handles from the Identity
 *        Registry's `claimed`/`released` event stream over Soroban RPC, with
 *        no cursor between requests. A public RPC endpoint only serves events
 *        within a bounded, empirically narrower-than-advertised window (see
 *        `EVENT_WINDOW_LEDGERS` below), so this sees only bindings claimed
 *        inside that window — roughly the last 11 hours. Everything older is
 *        invisible to it, permanently.
 *
 *      The database is used whenever one is configured and readable; the
 *      event stream is the fallback for deployments without an indexer, and
 *      for a database that is configured but unreachable. Which one answered
 *      is reported as `Directory.source`, because it determines what the page
 *      can honestly say about a listing shorter than the registry's `count()`.
 *
 *   2. **Confirmation** — `listDirectory` then asks the contract directly,
 *      via `resolveHandle`, whether each candidate is *actually* bound right
 *      now, and reads the registry's own `count()` as an upper bound on the
 *      total (see `boundTotal` for why it is a bound, not a truth).
 *
 * The second step is what keeps the page honest, whichever source discovered
 * a candidate. Discovery alone both under-reports and, when it comes back
 * empty, used to be indistinguishable from "nothing is bound" — which is how
 * curated demo handles ended up rendered as on-chain bindings. Candidates
 * that do not resolve are still listed, but carry `bound: false` so the UI
 * can label them as the previews they are.
 *
 * No database is *required*: with none configured the page still works off
 * the event stream and the curated manifest, exactly as before.
 */

export type DirectoryEntry = { handle: string; wallet: string };

type RawEvent = {
  kind: 'claimed' | 'released' | 'transferred';
  handle: string;
  wallet: string;
  from?: string;
};

/**
 * How far back to scan on every request (no cursor persisted between requests).
 *
 * 17,280 (~24h at ~5s/ledger) was the original assumption, matching the
 * public RPC's advertised retention. Empirically it does not hold: bisecting
 * against `https://soroban-testnet.stellar.org` found `getEvents` returns an
 * EMPTY result — not an error — once `startLedger` is roughly 10,700+ ledgers
 * (~15h) behind the current tip, well inside the advertised window. There is
 * nothing to catch: the response is a well-formed success with no events, so
 * a too-large window doesn't fail loudly, it just silently under-reports.
 *
 * 8,000 ledgers (~11h) keeps real margin below that observed floor. If this
 * endpoint's behavior changes, or a different provider is configured via
 * `SOROBAN_RPC_URL`, re-verify empirically before raising it — a `getEvents`
 * call from this endpoint will never tell you it truncated.
 */
const EVENT_WINDOW_LEDGERS = Number(process.env.REGISTRY_EVENT_WINDOW_LEDGERS ?? 8_000);
/** Safety cap so a slow/unreachable RPC can't turn this into an unbounded loop. */
const MAX_PAGES = 50;

// Re-exported so existing `lib/directory` importers keep their entry point;
// the registry/RPC configuration itself now lives in `lib/chain.ts`, shared
// with profile resolution.
export { isRegistryConfigured };

/**
 * Decode a raw contract event into a binding change, or null if it isn't
 * one we care about (wrong topic, malformed payload). Mirrors
 * apps/indexer/src/workers/attestation.ts's `decodeEvent` — duplicated
 * rather than shared, since the web app and the indexer are separately
 * deployable services with no shared stellar-events package yet.
 */
export function decodeEvent(topics: xdr.ScVal[], value: xdr.ScVal): RawEvent | null {
  try {
    if (topics.length < 2) return null;
    const kind = scValToNative(topics[0]!) as string;
    const handle = String(scValToNative(topics[1]!));
    if (!handle || !isValidHandle(handle)) return null;

    if (kind === 'transferred') {
      const pair = scValToNative(value) as unknown[] | null;
      const [from, wallet] = Array.isArray(pair) ? pair : [];
      if (!from || !wallet) return null;
      return { kind, handle, wallet: String(wallet), from: String(from) };
    }

    if (kind !== 'claimed' && kind !== 'released') return null;
    const wallet = String(scValToNative(value));
    if (!wallet) return null;
    return { kind, handle, wallet };
  } catch {
    return null;
  }
}

/**
 * Reduce an ordered (oldest → newest) event list to the currently-bound
 * set. A `released` always wins over any earlier `claimed` for the same
 * handle; a `transferred` updates the owner to the new wallet; the reverse is
 * true too if a handle gets claimed again later.
 */
export function reduceBindings(events: RawEvent[]): DirectoryEntry[] {
  const bound = new Map<string, string>();
  for (const ev of events) {
    if (ev.kind === 'claimed' || ev.kind === 'transferred') bound.set(ev.handle, ev.wallet);
    else bound.delete(ev.handle);
  }
  return [...bound.entries()]
    .map(([handle, wallet]) => ({ handle, wallet }))
    .sort((a, b) => a.handle.localeCompare(b.handle));
}

/**
 * Live directory read straight from the registry's event stream. Returns
 * null (rather than throwing) on any failure — contract not configured,
 * RPC unreachable, malformed response — so callers fall back instead of
 * breaking the page.
 */
export async function fetchLiveDirectory(): Promise<DirectoryEntry[] | null> {
  if (!isRegistryConfigured()) return null;

  try {
    const server = new rpc.Server(SOROBAN_RPC_URL, { allowHttp: ALLOW_HTTP });
    const { sequence: latestLedger } = await server.getLatestLedger();
    const startLedger = Math.max(1, latestLedger - EVENT_WINDOW_LEDGERS);

    const decoded: RawEvent[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const res = cursor
        ? await server.getEvents({
            filters: [{ type: 'contract', contractIds: [REGISTRY_CONTRACT_ID] }],
            cursor,
            limit: 200,
          })
        : await server.getEvents({
            filters: [{ type: 'contract', contractIds: [REGISTRY_CONTRACT_ID] }],
            startLedger,
            limit: 200,
          });

      for (const e of res.events) {
        const ev = decodeEvent(e.topic, e.value);
        if (ev) decoded.push(ev);
      }

      if (res.events.length < 200) break;
      cursor = res.cursor;
      if (!cursor) break;
    }

    return reduceBindings(decoded);
  } catch {
    return null;
  }
}

/**
 * Minimal slice of the Prisma client the durable read touches. Declaring it as
 * an interface (the same way `apps/indexer/src/workers/attestation.ts` declares
 * `AttestationStore`) lets tests inject a lightweight stub instead of standing
 * up Postgres, and keeps this module free of a hard `@signet/db` import.
 */
export interface DirectoryStore {
  wallet: {
    findMany(args: {
      where: { source: string; isPrimary: boolean };
      select: { pubkey: true; profile: { select: { handle: true } } };
    }): Promise<{ pubkey: string; profile: { handle: string } | null }[]>;
  };
}

/**
 * Durable directory read, from the indexer's database.
 *
 * The attestation worker writes one `Wallet` row per on-chain binding
 * (`source: 'onchain'`), deleting it again on `released`/`revoked`, and it
 * tracks its position with a persisted ledger cursor. So unlike the event
 * stream, this answer does not decay: a handle claimed a year ago is still
 * here. Only `source: 'onchain'` rows are read — curated seed rows are the
 * demo manifest wearing a database, and must never be discovered as if they
 * were registry bindings.
 *
 * Returns null (never throws) when there is no durable source to read: no
 * `DATABASE_URL`, or a database that is configured but unreachable. Callers
 * fall back to the event stream on null. An empty array is a real answer —
 * "the indexer knows of no bindings" — and is not the same thing.
 */
export async function fetchIndexedDirectory(
  store?: DirectoryStore,
): Promise<DirectoryEntry[] | null> {
  try {
    const db = store ?? (process.env.DATABASE_URL ? await loadPrismaStore() : null);
    if (!db) return null;

    const rows = await db.wallet.findMany({
      where: { source: 'onchain', isPrimary: true },
      select: { pubkey: true, profile: { select: { handle: true } } },
    });

    // A profile owns many wallets but only one primary, so a duplicate handle
    // here would be a data anomaly rather than a normal state; keep the first
    // and stay deterministic instead of rendering the same handle twice.
    const bound = new Map<string, string>();
    for (const row of rows) {
      const handle = row.profile?.handle;
      if (!handle || !isValidHandle(handle) || !row.pubkey) continue;
      if (!bound.has(handle)) bound.set(handle, row.pubkey);
    }

    return [...bound.entries()]
      .map(([handle, wallet]) => ({ handle, wallet }))
      .sort((a, b) => a.handle.localeCompare(b.handle));
  } catch {
    return null;
  }
}

/** Lazily loaded so the web app never hard-depends on Postgres being present. */
async function loadPrismaStore(): Promise<DirectoryStore> {
  const { prisma } = await import('@signet/db');
  return prisma as unknown as DirectoryStore;
}

/**
 * One row of `/handles`. `bound` is the only field the UI may treat as a
 * claim about on-chain state: it is true only when `resolve(handle)` came
 * back with a wallet just now.
 */
export type DirectoryListing = DirectoryEntry & { bound: boolean };

/**
 * Which discovery source answered — the fact the page needs to explain a
 * listing shorter than `boundTotal`:
 *
 *   `database` the indexer's durable tables. Nothing has aged out, so a
 *              shortfall means the counter drifted, the indexer is behind, or
 *              a binding lapsed from storage — never "too long ago".
 *   `events`   the registry's event stream only, which a public RPC serves for
 *              roughly the last 11 hours. A shortfall here is expected and
 *              grows without limit as the registry ages.
 *   `none`     neither source could be read (no indexer, and no registry
 *              configured or the RPC failed), so only the curated manifest is
 *              in play.
 */
export type DirectorySource = 'database' | 'events' | 'none';

export interface Directory {
  /** Bound entries first, then unconfirmed previews; alphabetical within each. */
  entries: DirectoryListing[];
  /**
   * The registry's own `count()` — an UPPER BOUND on bound handles, not an
   * authoritative total. The counter is adjusted on claim and release, but a
   * binding whose persistent storage lapses unaccessed emits no event and
   * runs no code, so nothing ever subtracts it: the counter drifts upward
   * permanently and cannot self-correct. Only a `resolve` proves a specific
   * binding is live (that is what `entries[].bound` carries). `null` when
   * the registry could not be read at all (not deployed, not configured,
   * RPC down), which is *not* the same as zero and must not be rendered as
   * one.
   */
  boundTotal: number | null;
  /**
   * Which discovery source produced the candidate set. The page must not
   * describe a shortfall against `boundTotal` without it: "claimed outside the
   * event window" is true of `events` and false of `database`.
   */
  source: DirectorySource;
}

/** Options for `listDirectory`, plus the injectable durable store for tests. */
export interface DirectoryReadOptions extends RegistryReadOptions {
  /** Override the database read. Tests inject a stub; production omits it. */
  store?: DirectoryStore;
}

/**
 * The list backing `/handles`.
 *
 * Discovers candidates from the durable indexer tables when one is configured
 * — the event stream otherwise — plus the curated manifest, then confirms each
 * one against the contract so a row is only ever marked bound when the chain
 * says so. Degrades instead of throwing: an unreadable registry yields
 * `boundTotal: null` and every candidate unconfirmed, so the page renders
 * previews under an honest caption rather than 500-ing.
 */
export async function listDirectory(options: DirectoryReadOptions = {}): Promise<Directory> {
  // Durable first. The event stream is only consulted when there is no
  // database to read, so a deployment with an indexer never pays for an RPC
  // scan whose answer it already has — and never inherits that scan's ~11h
  // horizon. An empty array from the database is an answer ("the indexer knows
  // of no bindings"); only null means "ask the chain instead".
  const indexed = await fetchIndexedDirectory(options.store);
  const [discovered, curated] = await Promise.all([
    indexed ?? fetchLiveDirectory(),
    listCuratedHandles(),
  ]);

  const source: DirectorySource = indexed ? 'database' : discovered ? 'events' : 'none';

  const candidates = [...new Set([...(discovered ?? []).map((e) => e.handle), ...curated])].sort(
    (a, b) => a.localeCompare(b),
  );

  // `boundCount` already answers null for an unconfigured or unreachable
  // registry, so no separate configured-check is needed here — and unlike
  // `chain.ts`'s module-level snapshot, it re-reads the environment per call.
  const [confirmed, boundTotal] = await Promise.all([
    Promise.all(
      candidates.map(async (handle) => {
        const wallet = await resolveHandle(handle, options);
        return { handle, wallet: wallet ?? '', bound: wallet !== null };
      }),
    ),
    boundCount(options),
  ]);

  // Bound handles lead; previews follow. `candidates` is already sorted, and
  // a stable partition preserves that order inside each group.
  const entries = [...confirmed.filter((e) => e.bound), ...confirmed.filter((e) => !e.bound)];

  return { entries, boundTotal, source };
}
