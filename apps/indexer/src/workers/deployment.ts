import type { Horizon } from '@stellar/stellar-sdk';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { extractContractAddress, sleep } from '../stellar.js';
import type { IndexerConfig } from '../config.js';

const RATE_LIMIT_DELAY_MS = 100;

export async function runDeploymentWorker(
  horizon: Horizon.Server,
  config: IndexerConfig,
): Promise<number> {
  const wallets = await prisma.wallet.findMany();
  let highestLedger = 0;

  for (const wallet of wallets) {
    logger.info({ pubkey: wallet.pubkey }, 'deployments.scanning');
    let newCount = 0;

    try {
      const ops = await horizon
        .operations()
        .forAccount(wallet.pubkey)
        .order('desc')
        .limit(200)
        .call();

      await sleep(RATE_LIMIT_DELAY_MS);

      for (const op of ops.records) {
        // Track highest ledger seen
        if (op.paging_token) {
          const ledgerSeq = Math.floor(Number(op.paging_token) / 4294967296);
          if (ledgerSeq > highestLedger) highestLedger = ledgerSeq;
        }

        if (op.type !== 'invoke_host_function') continue;

        // The SDK's operation type narrowing — use any to access function field
        // which is present on InvokeHostFunction operations from Horizon
        const opRecord = op as unknown as Record<string, unknown>;
        if (opRecord['function'] !== 'HostFunctionTypeCreateContract') continue;

        const txHash = op.transaction_hash;
        if (!txHash) continue;

        // Skip if we already have a contract from this tx
        const existing = await prisma.contract.findFirst({
          where: { deployTxHash: txHash },
        });
        if (existing) continue;

        // Fetch transaction to parse contract address from result meta
        await sleep(RATE_LIMIT_DELAY_MS);
        let contractAddress: string | null = null;

        try {
          const tx = await horizon.transactions().transaction(txHash).call();
          contractAddress = extractContractAddress(tx.result_meta_xdr);
          const ledgerSeq = tx.ledger_attr;
          if (typeof ledgerSeq === 'number' && ledgerSeq > highestLedger) {
            highestLedger = ledgerSeq;
          }

          if (contractAddress) {
            await prisma.contract.upsert({
              where:  { address: contractAddress },
              update: {},
              create: {
                address:       contractAddress,
                walletId:      wallet.id,
                deployerPubkey: wallet.pubkey,
                deployedAt:    new Date(tx.created_at),
                deployTxHash:  txHash,
                network:       config.network,
              },
            });
            newCount++;
            logger.info(
              { pubkey: wallet.pubkey, contract: contractAddress },
              'deployments.found',
            );
          }
        } catch (txErr) {
          logger.warn(
            { pubkey: wallet.pubkey, txHash, error: String(txErr) },
            'deployments.txFetchFailed',
          );
        }
      }
    } catch (err) {
      logger.error(
        { pubkey: wallet.pubkey, error: String(err) },
        'deployments.scanFailed',
      );
    }

    logger.info({ pubkey: wallet.pubkey, new: newCount }, 'deployments.walletDone');
  }

  return highestLedger;
}
