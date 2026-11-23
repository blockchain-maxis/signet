/**
 * Backfill script: populates `decodedFunction` and `contractAddress` on existing
 * `Operation` rows where `decodedFunction` is null.
 *
 * Reads rows in batches and fetches each operation from Horizon using the existing
 * throttle (RATE_LIMIT_DELAY_MS) and `withRetry`.
 */
import { prisma } from '@signet/db';
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

export async function runBackfill() {
  logger.info({ horizonUrl: HORIZON_URL }, 'backfill:operations starting');
  let totalProcessed = 0;
  let totalUpdated = 0;

  while (true) {
    const batch = await prisma.operation.findMany({
      where: { decodedFunction: null },
      take: BATCH_SIZE,
      orderBy: { createdAt: 'desc' },
      select: { id: true, function: true },
    });

    if (batch.length === 0) {
      break;
    }

    for (const op of batch) {
      totalProcessed++;
      try {
        const url = `${HORIZON_URL.replace(/\/+$/, '')}/operations/${op.id}`;
        const record = await withRetry(
          async () => {
            const res = await fetch(url);
            if (!res.ok) {
              throw new Error(`Horizon operation fetch failed: ${res.status} ${res.statusText}`);
            }
            return (await res.json()) as { parameters?: Array<{ type?: string; value?: string }> };
          },
          { label: RETRY_LABEL },
        );

        const decoded = decodeInvokeParameters(record.parameters);
        await prisma.operation.update({
          where: { id: op.id },
          data: {
            decodedFunction: decoded.fn ?? op.function ?? 'unknown',
            contractAddress: decoded.contract ?? undefined,
          },
        });
        totalUpdated++;
      } catch (err) {
        logger.warn({ opId: op.id, err }, 'backfill:operations failed for op');
      }

      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  logger.info({ totalProcessed, totalUpdated }, 'backfill:operations finished');
}

if (
  process.argv[1]?.endsWith('backfill-operations.ts') ||
  process.argv[1]?.endsWith('backfill-operations.js')
) {
  runBackfill()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'backfill:operations encountered fatal error');
      process.exit(1);
    });
}
