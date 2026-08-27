import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { ALLOW_HTTP, REGISTRY_CONTRACT_ID, SOROBAN_RPC_URL, isRegistryConfigured } from './chain.ts';
import { isValidHandle, listHandles as listCuratedHandles } from './profiles.ts';
import { boundCount, resolveHandle, type RegistryReadOptions } from './server/registry-read.ts';

/**
 * Public handle directory (powers `/handles`).
 *
 * Two different reads, for two different jobs:
 *
 *   1. **Discovery** — `fetchLiveDirectory` reconstructs handles from the
 *      Identity Registry's `claimed`/`released` event stream over Soroban
 *      RPC. This is how a handle nobody has told us about gets found. A
 *      public RPC endpoint only serves events within a bounded, empirically
 *      narrower-than-advertised window (see `EVENT_WINDOW_LEDGERS` below), so
 *      it sees only bindings claimed inside that window.
 *   2. **Confirmation** — `listDirectory` then asks the contract directly,
 *      via `resolveHandle`, whether each candidate is *actually* bound right
 *      now, and takes the authoritative total from the registry's own
 *      `count()`.
 *
 * The second step is what keeps the page honest. Event-stream discovery
 * alone both under-reports (a handle claimed before the window is invisible)
 * and, when it comes back empty, used to be indistinguishable from "nothing
 * is bound" — which is how curated demo handles ended up rendered as
 * on-chain bindings. Candidates that do not resolve are still listed, but
 * carry `bound: false` so the UI can label them as the previews they are.
 *
 * No database required either way: the indexer's Postgres-backed sync
 * (apps/indexer/src/workers/attestation.ts) is a separate, longer-lived
 * accelerant, not a dependency of this page.
 */

export type DirectoryEntry = { handle: string; wallet: string };

type RawEvent = { kind: 'claimed' | 'released'; handle: string; wallet: string };

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
    if (kind !== 'claimed' && kind !== 'released') return null;
    const handle = String(scValToNative(topics[1]!));
    const wallet = String(scValToNative(value));
    if (!handle || !wallet || !isValidHandle(handle)) return null;
    return { kind, handle, wallet };
  } catch {
    return null;
  }
}

/**
 * Reduce an ordered (oldest → newest) event list to the currently-bound
 * set. A `released` always wins over any earlier `claimed` for the same
 * handle; the reverse is true too if a handle gets claimed again later.
 */
export function reduceBindings(events: RawEvent[]): DirectoryEntry[] {
  const bound = new Map<string, string>();
  for (const ev of events) {
    if (ev.kind === 'claimed') bound.set(ev.handle, ev.wallet);
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
 * One row of `/handles`. `bound` is the only field the UI may treat as a
 * claim about on-chain state: it is true only when `resolve(handle)` came
 * back with a wallet just now.
 */
export type DirectoryListing = DirectoryEntry & { bound: boolean };

export interface Directory {
  /** Bound entries first, then unconfirmed previews; alphabetical within each. */
  entries: DirectoryListing[];
  /**
   * The registry's own `count()` — the authoritative number of bound
   * handles. `null` when the registry could not be read at all (not
   * deployed, not configured, RPC down), which is *not* the same as zero
   * and must not be rendered as one.
   */
  boundTotal: number | null;
}

/**
 * The list backing `/handles`.
 *
 * Discovers candidates from the event stream and the curated manifest, then
 * confirms each one against the contract so a row is only ever marked bound
 * when the chain says so. Degrades instead of throwing: an unreadable
 * registry yields `boundTotal: null` and every candidate unconfirmed, so the
 * page renders previews under an honest caption rather than 500-ing.
 */
export async function listDirectory(options: RegistryReadOptions = {}): Promise<Directory> {
  const [discovered, curated] = await Promise.all([fetchLiveDirectory(), listCuratedHandles()]);

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

  return { entries, boundTotal };
}
