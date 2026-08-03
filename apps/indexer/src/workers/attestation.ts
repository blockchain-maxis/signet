import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
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
  kind: 'claimed' | 'released' | 'revoked';
  handle: string;
  wallet: string;
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
  };
  wallet: {
    upsert(args: {
      where: { pubkey: string };
      update: Record<string, unknown>;
      create: Record<string, unknown>;
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
 *   topics = [ symbol("claimed"|"released"|"revoked"), string(handle) ],  data = address(wallet)
 */
export function decodeEvent(topics: xdr.ScVal[], value: xdr.ScVal): AttestationEvent | null {
  try {
    if (topics.length < 2) return null;
    const kind = scValToNative(topics[0]!) as string;
    if (kind !== 'claimed' && kind !== 'released' && kind !== 'revoked') return null;
    const handle = String(scValToNative(topics[1]!));
    const wallet = String(scValToNative(value));
    if (!handle || !wallet) return null;
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
  } else {
    // released / revoked → drop the binding (the wallet row carries the link).
    await store.wallet.deleteMany({ where: { pubkey: ev.wallet } });
  }
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
 */
export async function runAttestationWorker(
  server: rpc.Server,
  config: IndexerConfig,
  cursorStore?: CursorStore,
  eventStore?: AttestationStore,
): Promise<{ eventsDecoded: number }> {
  if (!config.registryContractId) {
    logger.debug({}, 'attestation.skip — no registry contract configured');
    return { eventsDecoded: 0 };
  }

  const store = cursorStore ?? (prisma as unknown as CursorStore);
  const evStore = eventStore ?? (prisma as unknown as AttestationStore);

  // Resume from the cursor, or start `eventWindowLedgers` back on first run.
  const cursor = await store.indexerCursor.findUnique({ where: { id: CURSOR_ID } });
  let startLedger: number;
  if (cursor && cursor.lastLedger > 0) {
    startLedger = cursor.lastLedger + 1;
  } else {
    const { sequence } = await server.getLatestLedger();
    startLedger = Math.max(1, sequence - config.eventWindowLedgers);
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
