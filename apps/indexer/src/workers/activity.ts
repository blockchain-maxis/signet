import type { Horizon } from '@stellar/stellar-sdk';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { sleep } from '../stellar.js';

const RATE_LIMIT_DELAY_MS = 100;
const SNAPSHOT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function runActivityWorker(horizon: Horizon.Server): Promise<void> {
  const contracts = await prisma.contract.findMany({
    include: {
      snapshots: {
        orderBy: { capturedAt: 'desc' },
        take: 1,
      },
    },
  });

  for (const contract of contracts) {
    const lastSnapshot = contract.snapshots[0];

    // Skip if snapshot is fresh
    if (lastSnapshot) {
      const age = Date.now() - lastSnapshot.capturedAt.getTime();
      if (age < SNAPSHOT_TTL_MS) continue;
    }

    let txCountTotal = 0;
    let txCount24h = 0;
    let lastActivity: Date | null = null;
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    try {
      // Horizon supports querying transactions for Soroban contract accounts
      const txs = await horizon
        .transactions()
        .forAccount(contract.address)
        .order('desc')
        .limit(200)
        .call();

      await sleep(RATE_LIMIT_DELAY_MS);

      for (const tx of txs.records) {
        txCountTotal++;
        const txDate = new Date(tx.created_at);
        if (txDate > cutoff24h) txCount24h++;
        if (!lastActivity || txDate > lastActivity) lastActivity = txDate;
      }
    } catch {
      // Contract may not have any indexed transactions; set 0 counts
      logger.warn({ contract: contract.address }, 'activity.queryFailed — using 0 counts');
    }

    await prisma.contractSnapshot.create({
      data: {
        contractId:   contract.id,
        txCount24h,
        txCountTotal,
        lastActivity,
      },
    });

    logger.info(
      { contract: contract.address, txCountTotal, txCount24h },
      'activity.refreshed',
    );
  }
}
