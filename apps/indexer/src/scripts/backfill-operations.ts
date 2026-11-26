/**
 * Backfill script: populates `decodedFunction` and `contractAddress` on existing
 * `Operation` rows where `decodedFunction` is null.
 *
 * Reads rows in batches and fetches each operation from Horizon using the existing
 * throttle (RATE_LIMIT_DELAY_MS) and `withRetry`.
 *
 * The walk pages by `id` (newest first, `id < last`), so a row whose Horizon
 * fetch fails, or whose record decodes to no contract function, is visited
 * once per run and never re-selected. Such rows keep `decodedFunction: null`;
 * nothing is invented for them, because every distinct value counts towards
 * the unique-functions stat.
 */
import { decodeInvokeParameters } from '@signet/visualiser';
import { withRetry } from '../retry.js';
import { sleep } from '../stellar.js';
import { logger } from '../logger.js';

const RATE_LIMIT_DELAY_MS = 100;
const RETRY_LABEL = 'operations.backfill';
const BATCH_SIZE = 50;

const HORIZON_URL =
  process.env.INDEXER_HORIZON_URL ??
  process.env.HORIZON_URL ??
  'https://horizon-testnet.stellar.org';

type HorizonParameters = Array<{ type?: string; value?: string }>;

/** The slice of the Prisma client the backfill touches. */
export interface BackfillStore {
  operation: {
    findMany(args: {
      where: { decodedFunction: null; id?: { lt: string } };
      take: number;
      orderBy: { id: 'desc' };
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
    update(args: {
      where: { id: string };
      data: { decodedFunction: string; contractAddress?: string };
    }): Promise<unknown>;
  };
}

export interface BackfillDeps {
  store: BackfillStore;
  /** Fetches one Horizon operation record's `parameters`. */
  fetchParameters?: (id: string) => Promise<HorizonParameters | undefined>;
  delayMs?: number;
  batchSize?: number;
}

async function fetchHorizonParameters(id: string): Promise<HorizonParameters | undefined> {
  const url = `${HORIZON_URL.replace(/\/+$/, '')}/operations/${id}`;
  const record = await withRetry(
    async () => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Horizon operation fetch failed: ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as { parameters?: HorizonParameters };
    },
    { label: RETRY_LABEL },
  );
  return record.parameters;
}

export async function runBackfill(deps: BackfillDeps) {
  const {
    store,
    fetchParameters = fetchHorizonParameters,
    delayMs = RATE_LIMIT_DELAY_MS,
    batchSize = BATCH_SIZE,
  } = deps;
  logger.info({ horizonUrl: HORIZON_URL }, 'backfill:operations starting');
  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalFailed = 0;
  let last: string | undefined;

  while (true) {
    const batch = await store.operation.findMany({
      where: { decodedFunction: null, ...(last !== undefined ? { id: { lt: last } } : {}) },
      take: batchSize,
      orderBy: { id: 'desc' },
      select: { id: true },
    });

    if (batch.length === 0) {
      break;
    }
    last = batch[batch.length - 1]!.id;

    for (const op of batch) {
      totalProcessed++;
      try {
        const decoded = decodeInvokeParameters(await fetchParameters(op.id));
        // A record that does not decode to a contract function stays null.
        if (decoded.fn) {
          await store.operation.update({
            where: { id: op.id },
            data: {
              decodedFunction: decoded.fn,
              ...(decoded.contract ? { contractAddress: decoded.contract } : {}),
            },
          });
          totalUpdated++;
        }
      } catch (err) {
        totalFailed++;
        logger.warn({ opId: op.id, err }, 'backfill:operations failed for op');
      }

      if (delayMs > 0) await sleep(delayMs);
    }
  }

  logger.info({ totalProcessed, totalUpdated, totalFailed }, 'backfill:operations finished');
  return { totalProcessed, totalUpdated, totalFailed };
}

if (
  process.argv[1]?.endsWith('backfill-operations.ts') ||
  process.argv[1]?.endsWith('backfill-operations.js')
) {
  import('@signet/db')
    .then(({ prisma }) => runBackfill({ store: prisma as unknown as BackfillStore }))
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'backfill:operations encountered fatal error');
      process.exit(1);
    });
}
