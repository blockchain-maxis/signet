import { Contract, xdr, type rpc } from '@stellar/stellar-sdk';
import { logger } from '../logger.js';
import type { IndexerConfig } from '../config.js';

export interface ExecutableRefreshContract {
  id: string;
  address: string;
  wasmHash: string | null;
  wasmHashCheckedAt: Date | null;
}

export interface ExecutableRefreshStore {
  contract: {
    findMany: (args: {
      where: {
        OR: [{ wasmHashCheckedAt: null }, { wasmHashCheckedAt: { lte: Date } }];
      };
      select: {
        id: true;
        address: true;
        wasmHash: true;
        wasmHashCheckedAt: true;
      };
    }) => Promise<ExecutableRefreshContract[]>;
    update: (args: {
      where: { id: string };
      data: {
        wasmHash?: string | null;
        wasmHashCheckedAt: Date;
      };
    }) => Promise<unknown>;
  };
  contractWasmVersion: {
    upsert: (args: {
      where: {
        contractId_wasmHash: {
          contractId: string;
          wasmHash: string;
        };
      };
      update: Record<string, never>;
      create: {
        contractId: string;
        wasmHash: string;
        observedLedger: number;
      };
    }) => Promise<unknown>;
  };
}

export interface ExecutableRefreshResult {
  contractsChecked: number;
  wasmChanged: number;
  missingEntries: number;
}

export type SorobanRpcLike = Pick<rpc.Server, 'getLedgerEntries'>;

const BATCH_SIZE = 100;

/**
 * Decode a WASM hash hex string from a Soroban LedgerEntryData if it is a WASM contract instance.
 */
export function extractWasmHash(entryData: xdr.LedgerEntryData): string | null {
  try {
    const data = entryData.contractData();
    const val = data.val();
    const instance = val.instance();
    const executable = instance.executable();
    if (executable.switch().name === 'contractExecutableWasm' || executable.switch().value === 0) {
      return executable.wasmHash().toString('hex').toLowerCase();
    }
  } catch {
    // Non-instance or unexpected shape
  }
  return null;
}

/**
 * Periodically refresh contract executables from Soroban RPC to backfill missing hashes
 * and detect upgrades on-chain.
 */
export async function runExecutableRefreshWorker(
  rpcClient: SorobanRpcLike,
  config: IndexerConfig,
  store: ExecutableRefreshStore,
  now = new Date(),
): Promise<ExecutableRefreshResult> {
  const cutoff = new Date(now.getTime() - config.executableRefreshIntervalMs);

  const contracts = await store.contract.findMany({
    where: {
      OR: [{ wasmHashCheckedAt: null }, { wasmHashCheckedAt: { lte: cutoff } }],
    },
    select: {
      id: true,
      address: true,
      wasmHash: true,
      wasmHashCheckedAt: true,
    },
  });

  if (contracts.length === 0) {
    return { contractsChecked: 0, wasmChanged: 0, missingEntries: 0 };
  }

  let wasmChanged = 0;
  let missingEntries = 0;

  for (let i = 0; i < contracts.length; i += BATCH_SIZE) {
    const batch = contracts.slice(i, i + BATCH_SIZE);

    // Map base64 ledger key -> contract item
    const keyMap = new Map<string, ExecutableRefreshContract>();
    const keys: xdr.LedgerKey[] = [];

    for (const item of batch) {
      try {
        const key = new Contract(item.address).getFootprint();
        const b64 = key.toXDR('base64');
        keyMap.set(b64, item);
        keys.push(key);
      } catch (err) {
        logger.warn(
          { contract: item.address, error: String(err) },
          'executableRefresh.invalidAddress',
        );
      }
    }

    if (keys.length === 0) continue;

    let response: Awaited<ReturnType<SorobanRpcLike['getLedgerEntries']>>;
    try {
      response = await (
        rpcClient.getLedgerEntries as unknown as (...k: xdr.LedgerKey[]) => Promise<any>
      )(...keys);
    } catch (err) {
      logger.error({ error: String(err), count: keys.length }, 'executableRefresh.rpcFailed');
      continue;
    }

    const latestLedger = response.latestLedger ?? 0;
    const entries = response.entries ?? [];

    // Track which contracts in this batch were returned by RPC
    const foundKeys = new Set<string>();

    for (const entry of entries) {
      let keyB64: string;
      if (typeof entry.key === 'string') {
        keyB64 = entry.key;
      } else if (entry.key && typeof (entry.key as any).toXDR === 'function') {
        keyB64 = (entry.key as any).toXDR('base64');
      } else {
        continue;
      }

      const contract = keyMap.get(keyB64);
      if (!contract) continue;

      foundKeys.add(keyB64);

      let entryData: xdr.LedgerEntryData | null = null;
      if (entry.val && typeof (entry.val as any).contractData === 'function') {
        entryData = entry.val as unknown as xdr.LedgerEntryData;
      } else if ((entry as any).xdr) {
        try {
          entryData = xdr.LedgerEntryData.fromXDR((entry as any).xdr, 'base64');
        } catch {
          entryData = null;
        }
      }

      const newHash = entryData ? extractWasmHash(entryData) : null;
      const oldHash = contract.wasmHash;

      try {
        if (newHash && newHash !== oldHash) {
          logger.info(
            { contract: contract.address, from: oldHash, to: newHash },
            'deployments.wasmChanged',
          );

          // Version row first (idempotent upsert on the unique key, so a
          // rollback to an earlier hash adds no row), then the Contract row.
          // If the second write fails, the next tick still sees the old hash,
          // re-detects the change and retries; the reverse order would lose
          // the version permanently.
          await store.contractWasmVersion.upsert({
            where: {
              contractId_wasmHash: {
                contractId: contract.id,
                wasmHash: newHash,
              },
            },
            update: {},
            create: {
              contractId: contract.id,
              wasmHash: newHash,
              observedLedger: latestLedger,
            },
          });

          await store.contract.update({
            where: { id: contract.id },
            data: {
              wasmHash: newHash,
              wasmHashCheckedAt: now,
            },
          });

          wasmChanged++;
        } else {
          // Hash unchanged (or non-wasm executable) -> bump check timestamp
          await store.contract.update({
            where: { id: contract.id },
            data: {
              wasmHashCheckedAt: now,
            },
          });
        }
      } catch (err) {
        // One bad row must not abort the tick (pruning and the cursor write
        // run after this worker); it stays due and is retried next tick.
        logger.error(
          { contract: contract.address, error: String(err) },
          'executableRefresh.contractFailed',
        );
      }
    }

    // Process missing entries (archived or not found)
    for (const [keyB64, contract] of keyMap.entries()) {
      if (!foundKeys.has(keyB64)) {
        missingEntries++;
        try {
          await store.contract.update({
            where: { id: contract.id },
            data: {
              wasmHashCheckedAt: now,
            },
          });
        } catch (err) {
          logger.error(
            { contract: contract.address, error: String(err) },
            'executableRefresh.contractFailed',
          );
        }
      }
    }
  }

  return {
    contractsChecked: contracts.length,
    wasmChanged,
    missingEntries,
  };
}
