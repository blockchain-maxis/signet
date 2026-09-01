import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import type { WalletSource } from '@signet/types';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { createRegistryReader, type RegistryReader } from '../registry-read.js';
import type { IndexerConfig } from '../config.js';

/**
 * Attestation worker — Phase 2.
 *
 * Reads the Identity Registry's `claimed` / `released` event stream from
 * Soroban RPC and syncs the resulting wallet↔handle bindings into the database.
 * This is what makes a self-sovereign on-chain claim show up on the website:
 * the curated `seed-data.ts` mapping becomes a fallback, and on-chain truth
 * takes over.
 *
 * A dedicated cursor (`IndexerCursor` id = `attestation`) tracks the last
 * processed ledger so each tick only reads new events.
 */

const CURSOR_ID = 'attestation';

export type AttestationEvent = {
  kind: 'claimed' | 'released' | 'revoked' | 'transferred';
  handle: string;
  wallet: string;
  from?: string;
};

/**
 * Minimal slice of the Prisma client this worker touches. Declaring it as an
 * interface lets tests inject a lightweight mock instead of a real database.
 */
export interface AttestationStore {
  profile: {
    upsert(args: {
      where: { handle: string };
      update: Record<string, unknown>;
      create: { handle: string };
    }): Promise<{ id: string }>;
    findMany(args: {
      select: { handle: true; wallets: { select: { pubkey: true; source: true } } };
    }): Promise<{ handle: string; wallets: { pubkey: string; source: WalletSource }[] }[]>;
  };
  wallet: {
    upsert(args: {
      where: { pubkey: string };
      update: { profileId: string; source: WalletSource; isPrimary: boolean };
      create: { pubkey: string; profileId: string; source: WalletSource; isPrimary: boolean };
    }): Promise<unknown>;
    deleteMany(args: { where: { pubkey: string } }): Promise<unknown>;
  };
}

/**
 * Minimal cursor persistence interface. Tests can inject a lightweight mock
 * instead of depending on a real database. The `indexerCursor` nesting mirrors
 * the Prisma client's own shape so the production default can be passed
 * straight through, the same way `AttestationStore` does.
 */
export interface CursorStore {
  indexerCursor: {
    findUnique(args: { where: { id: string } }): Promise<{ lastLedger: number } | null>;
    upsert(args: {
      where: { id: string };
      update: { lastLedger: number };
      create: { id: string; lastLedger: number };
    }): Promise<unknown>;
  };
}

/**
 * Decode a raw contract event into an `AttestationEvent`, or `null` if the
 * event isn't one we care about (wrong topic, malformed payload).
 *
 * The contract publishes:
 *   topics = [ symbol("claimed"|"released"|"revoked"|"transferred"), string(handle) ],
 *   data = address(wallet) for single-wallet events and [old_owner, new_wallet] for transfer.
 */
export function decodeEvent(topics: xdr.ScVal[], value: xdr.ScVal): AttestationEvent | null {
  try {
    if (topics.length < 2) return null;
    const kind = scValToNative(topics[0]!) as string;
    const handle = String(scValToNative(topics[1]!));
    if (!handle) return null;

    if (kind === 'transferred') {
      const pair = scValToNative(value) as unknown[] | null;
      const [from, wallet] = Array.isArray(pair) ? pair : [];
      if (!from || !wallet) return null;
      return { kind, handle, wallet: String(wallet), from: String(from) };
    }

    if (kind !== 'claimed' && kind !== 'released' && kind !== 'revoked') return null;
    const wallet = String(scValToNative(value));
    if (!wallet) return null;
    return { kind, handle, wallet };
  } catch {
    return null;
  }
}

/** Apply a single decoded event to the store. Idempotent. */
export async function applyAttestation(
  store: AttestationStore,
  ev: AttestationEvent,
): Promise<void> {
  if (ev.kind === 'claimed') {
    const profile = await store.profile.upsert({
      where: { handle: ev.handle },
      update: {},
      create: { handle: ev.handle },
    });
    await store.wallet.upsert({
      where: { pubkey: ev.wallet },
      update: { profileId: profile.id, source: 'onchain', isPrimary: true },
      create: { pubkey: ev.wallet, profileId: profile.id, source: 'onchain', isPrimary: true },
    });
  } else if (ev.kind === 'transferred') {
    const profile = await store.profile.upsert({
      where: { handle: ev.handle },
      update: {},
      create: { handle: ev.handle },
    });
    if (ev.from) {
      await store.wallet.deleteMany({ where: { pubkey: ev.from } });
    }
    await store.wallet.upsert({
      where: { pubkey: ev.wallet },
      update: { profileId: profile.id, source: 'onchain', isPrimary: true },
      create: { pubkey: ev.wallet, profileId: profile.id, source: 'onchain', isPrimary: true },
    });
  } else {
    // released / revoked → drop the binding (the wallet row carries the link).
    await store.wallet.deleteMany({ where: { pubkey: ev.wallet } });
  }
}

/** What a reconcile pass did, for the tick log and for tests. */
export interface ReconcileStats {
  /** Handles the database knew about (curated + previously indexed). */
  candidates: number;
  /** Candidates the chain confirms as bound right now. */
  bound: number;
  /** Stale on-chain wallet rows removed (released, revoked, or transferred away). */
  removed: number;
  /** The registry's own count(), when readable. */
  chainCount: number | null;
  /** chainCount minus confirmed candidates - bindings the database has never seen. */
  unknownOnChain: number;
}

/**
 * Rebuild binding state from the CONTRACT instead of the event stream.
 *
 * Events are only served inside the RPC's retention window; contract state has
 * no such horizon. Sweeping every handle the database knows about through
 * `resolve` re-learns claims the lost window contained (for known handles),
 * heals transfers, and drops bindings that were released or revoked - all
 * idempotent, all without a manual database edit.
 *
 * What it cannot do is NAME a handle the database has never seen. The
 * `count()` cross-check below at least detects that such handles exist, so the
 * loss is raised loudly instead of passing silently.
 */
export async function reconcileAgainstChain(
  store: AttestationStore,
  reader: RegistryReader,
): Promise<ReconcileStats> {
  const profiles = await store.profile.findMany({
    select: { handle: true, wallets: { select: { pubkey: true, source: true } } },
  });
  const resolved = await reader.resolveMany(profiles.map((p) => p.handle));

  // Every wallet some handle resolves to right now. The deletions below run
  // against the PRE-sweep snapshot, and a wallet the snapshot links to handle
  // A may meanwhile own handle B on-chain: processing B upserts the row, and
  // processing A later must not delete what that upsert just re-pointed.
  // Deleting only wallets no resolved handle claims makes the sweep
  // order-independent.
  const boundNow = new Set(resolved.filter((w): w is string => typeof w === 'string'));

  let bound = 0;
  let removed = 0;
  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i]!;
    const wallet = resolved[i] ?? null;
    // Curated demo wallets are not on-chain claims; only rows the indexer
    // itself attested may be reconciled away.
    const onchain = profile.wallets.filter((w) => w.source === 'onchain');
    if (wallet) {
      bound++;
      await applyAttestation(store, { kind: 'claimed', handle: profile.handle, wallet });
    }
    for (const w of onchain) {
      // Stale link: this wallet is not (or no longer) what the handle
      // resolves to - released, revoked, or transferred away. Keep it if any
      // OTHER handle resolves to it now.
      if (w.pubkey !== wallet && !boundNow.has(w.pubkey)) {
        await store.wallet.deleteMany({ where: { pubkey: w.pubkey } });
        removed++;
      }
    }
  }

  const chainCount = await reader.count();
  const unknownOnChain = chainCount === null ? 0 : Math.max(0, chainCount - bound);
  return { candidates: profiles.length, bound, removed, chainCount, unknownOnChain };
}

/**
 * Run the attestation worker tick.
 *
 * @param server      Soroban RPC server
 * @param config      Indexer configuration
 * @param cursorStore Optional cursor store (defaults to the real Prisma client).
 *                    Tests inject a mock to verify cursor resumption.
 * @param eventStore  Optional event store (defaults to the real Prisma client).
 *                    Tests inject a mock to verify events are applied only once.
 * @param registryReader Optional contract-state reader (defaults to view
 *                    simulations against `server`). Tests inject a fake to
 *                    drive the reconcile path.
 */
export async function runAttestationWorker(
  server: rpc.Server,
  config: IndexerConfig,
  cursorStore?: CursorStore,
  eventStore?: AttestationStore,
  registryReader?: RegistryReader,
): Promise<{ eventsDecoded: number; reconciled?: ReconcileStats }> {
  if (!config.registryContractId) {
    logger.debug({}, 'attestation.skip — no registry contract configured');
    return { eventsDecoded: 0 };
  }

  const store = cursorStore ?? (prisma as unknown as CursorStore);
  const evStore = eventStore ?? (prisma as unknown as AttestationStore);

  // Resume from the cursor, or start `eventWindowLedgers` back on first run.
  const cursor = await store.indexerCursor.findUnique({ where: { id: CURSOR_ID } });
  const { sequence: latest } = await server.getLatestLedger();
  let startLedger: number;
  if (cursor && cursor.lastLedger > 0) {
    startLedger = cursor.lastLedger + 1;

    // The RPC only serves events inside its retention window, and past it the
    // response is a normal 200 with `events: []` - not an error, so there is
    // nothing to catch and the gap would be skipped silently while the cursor
    // jumped to the tip. If the indexer was down long enough that our resume
    // point is no longer safely servable (`eventWindowLedgers` is deliberately
    // inside the observed retention floor), reading events cannot recover the
    // gap. Reconcile against contract state instead, then resume from the tip.
    if (latest - startLedger > config.eventWindowLedgers) {
      const reader =
        registryReader ?? createRegistryReader(server, config.registryContractId, config.network);
      logger.warn(
        { startLedger, latest, gap: latest - startLedger },
        'attestation.reconcile.start - cursor outside event retention',
      );
      try {
        const stats = await reconcileAgainstChain(evStore, reader);
        // Resume from the near edge of the servable window, not the tip: the
        // sweep can only cover handles the database knows, but the tail of
        // the window is still readable as EVENTS - so the next tick replays
        // it (idempotently) and catches claims of handles the sweep could
        // not know about. Only the truly unservable middle is ceded.
        const resumeFrom = Math.max(1, latest - config.eventWindowLedgers);
        await store.indexerCursor.upsert({
          where: { id: CURSOR_ID },
          update: { lastLedger: resumeFrom },
          create: { id: CURSOR_ID, lastLedger: resumeFrom },
        });
        if (stats.unknownOnChain > 0) {
          // The registry says more handles are bound than we could confirm:
          // handles the database has never seen. Ones claimed in the still-
          // servable tail arrive with the next tick's event read (the cursor
          // resumes at the window's near edge); older ones take an
          // archival-RPC backfill (docs/INDEXER.md) - or the counter itself
          // has drifted upward after archival.
          logger.error(
            { ...stats, startLedger, latest },
            'attestation.reconcile.countMismatch - bindings exist on-chain that the database has never seen',
          );
        } else {
          logger.warn(
            { ...stats, startLedger, latest },
            'attestation.reconciled - cursor fell outside event retention; state rebuilt from the contract',
          );
        }
        return { eventsDecoded: 0, reconciled: stats };
      } catch (err) {
        // Leave the cursor untouched: reconcile is retried next tick, and a
        // transient RPC failure must not turn into a silent skip-to-tip.
        logger.error({ error: String(err), startLedger, latest }, 'attestation.reconcileFailed');
        return { eventsDecoded: 0 };
      }
    }
  } else {
    startLedger = Math.max(1, latest - config.eventWindowLedgers);
  }

  let applied = 0;
  let latestLedger = startLedger;

  try {
    const res = await server.getEvents({
      startLedger,
      filters: [{ type: 'contract', contractIds: [config.registryContractId] }],
      limit: 200,
    });
    latestLedger = res.latestLedger;

    for (const e of res.events) {
      const decoded = decodeEvent(e.topic, e.value);
      if (!decoded) continue;
      await applyAttestation(evStore, decoded);
      applied++;
      logger.debug(
        { kind: decoded.kind, handle: decoded.handle, ledger: e.ledger },
        'attestation.applied',
      );
    }
  } catch (err) {
    logger.error({ error: String(err), startLedger }, 'attestation.fetchFailed');
    // Leave the cursor untouched so we retry this window next tick.
    return { eventsDecoded: applied };
  }

  await store.indexerCursor.upsert({
    where: { id: CURSOR_ID },
    update: { lastLedger: latestLedger },
    create: { id: CURSOR_ID, lastLedger: latestLedger },
  });

  logger.debug({ applied, throughLedger: latestLedger }, 'attestation.done');
  return { eventsDecoded: applied };
}
