import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { ALLOW_HTTP, REGISTRY_CONTRACT_ID, SOROBAN_RPC_URL, isRegistryConfigured } from './chain.ts';
import { isValidHandle, listHandles as listCuratedHandles } from './profiles.ts';

/**
 * Public handle directory (powers `/handles`).
 *
 * Reconstructs the *currently* bound set of handles straight from the
 * Identity Registry's `claimed`/`released` event stream over Soroban RPC.
 * No database required: the indexer's Postgres-backed sync
 * (apps/indexer/src/workers/attestation.ts) is a separate, longer-lived
 * accelerant, not a dependency of this page.
 *
 * A public RPC endpoint only retains events for a bounded window (the
 * default below mirrors the indexer's own cold-start window), so this can
 * only see bindings claimed within that window. That's an accepted
 * tradeoff for a page with no persistence of its own: it always reflects
 * live on-chain state within the window, and falls back to the curated
 * demo manifest when the registry isn't deployed yet or the RPC call fails
 * outright, so the page never 500s either way.
 */

export type DirectoryEntry = { handle: string; wallet: string };

type RawEvent = { kind: 'claimed' | 'released'; handle: string; wallet: string };

/** How far back to scan on every request (no cursor persisted between requests). */
const EVENT_WINDOW_LEDGERS = Number(process.env.REGISTRY_EVENT_WINDOW_LEDGERS ?? 17_280);
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
 * The list backing `/handles`: prefers the live on-chain directory, falls
 * back to the curated demo manifest so the page always has something to
 * show — and an honest empty state, not a crash — whether or not the
 * registry is deployed yet.
 */
export async function listDirectory(): Promise<DirectoryEntry[]> {
  const live = await fetchLiveDirectory();
  if (live && live.length > 0) return live;

  const curated = await listCuratedHandles();
  return curated
    .map((handle) => ({ handle, wallet: '' }))
    .sort((a, b) => a.handle.localeCompare(b.handle));
}
