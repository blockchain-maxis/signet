import { Address, StrKey, xdr, rpc } from '@stellar/stellar-sdk';
import { logger } from '../logger.js';
import { sleep } from '../stellar.js';
import { withRetry } from '../retry.js';
import type { IndexerConfig } from '../config.js';

const RATE_LIMIT_DELAY_MS = 100;
const RETRY_LABEL = 'invocations.soroban';

/** A tracked contract as far as the invocations worker is concerned. */
export interface InvocationsContract {
  id: string;
  address: string;
  wasmHash: string | null;
}

/** Fields written to a `ContractInvocation` row on create. */
export interface ContractInvocationCreate {
  id: string;
  contractId: string;
  txHash: string;
  ledger: number;
  createdAt: Date;
  sourceAccount: string;
  function: string | null;
  successful: boolean;
  wasmHash: string | null;
  readOnly: string[];
  readWrite: string[];
  changed: string[] | null;
  callEdges?: unknown;
  eventsContractIds: string[];
}

/** Fields refreshed on an existing `ContractInvocation` row. */
export interface ContractInvocationUpdate {
  successful: boolean;
  wasmHash: string | null;
  readOnly: string[];
  readWrite: string[];
  changed: string[] | null;
  eventsContractIds: string[];
}

/**
 * Persistence surface the invocations worker needs — an injectable seam
 * following the ActivityStore and OperationsStore pattern.
 */
export interface InvocationsStore {
  contract: {
    findMany: (args?: {
      select?: { id: true; address: true; wasmHash: true };
    }) => Promise<InvocationsContract[]>;
  };
  contractInvocation: {
    findFirst: (args: {
      where: { contractId: string };
      orderBy: { createdAt: 'desc' };
      select: { txHash: true; ledger: true };
    }) => Promise<{ txHash: string; ledger: number } | null>;
    upsert: (args: {
      where: { id: string };
      update: ContractInvocationUpdate;
      create: ContractInvocationCreate;
    }) => Promise<unknown>;
  };
}

export interface InvocationsResult {
  invocationsUpserted: number;
  contractsScanned: number;
}

export type SorobanInvocationsRpc = Pick<rpc.Server, 'getLatestLedger' | 'getEvents' | 'getTransaction'>;

/**
 * Convert a raw LedgerEntry into its corresponding LedgerKey XDR object.
 */
export function ledgerEntryToLedgerKey(entry: xdr.LedgerEntry): xdr.LedgerKey {
  const data = entry.data();
  const arm = (data as any).arm ? (data as any).arm() : data.switch().name;
  switch (arm) {
    case 'account':
      return xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: data.account().accountId() }));
    case 'trustLine':
    case 'trustline':
      return xdr.LedgerKey.trustline(
        new xdr.LedgerKeyTrustLine({
          accountId: data.trustLine().accountId(),
          asset: data.trustLine().asset(),
        }),
      );
    case 'offer':
      return xdr.LedgerKey.offer(
        new xdr.LedgerKeyOffer({
          sellerId: data.offer().sellerId(),
          offerId: data.offer().offerId(),
        }),
      );
    case 'data':
      return xdr.LedgerKey.data(
        new xdr.LedgerKeyData({
          accountId: data.data().accountId(),
          dataName: data.data().dataName(),
        }),
      );
    case 'claimableBalance':
      return xdr.LedgerKey.claimableBalance(
        new xdr.LedgerKeyClaimableBalance({
          balanceId: data.claimableBalance().balanceId(),
        }),
      );
    case 'liquidityPool':
      return xdr.LedgerKey.liquidityPool(
        new xdr.LedgerKeyLiquidityPool({
          liquidityPoolId: data.liquidityPool().liquidityPoolId(),
        }),
      );
    case 'contractData':
      return xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: data.contractData().contract(),
          key: data.contractData().key(),
          durability: data.contractData().durability(),
        }),
      );
    case 'contractCode':
      return xdr.LedgerKey.contractCode(
        new xdr.LedgerKeyContractCode({
          hash: data.contractCode().hash(),
        }),
      );
    case 'configSetting': {
      const cs = data.configSetting() as any;
      const configSettingId = cs.configSettingId ? cs.configSettingId() : cs;
      return xdr.LedgerKey.configSetting(
        new xdr.LedgerKeyConfigSetting({
          configSettingId,
        }),
      );
    }
    case 'ttl':
      return xdr.LedgerKey.ttl(
        new xdr.LedgerKeyTtl({
          keyHash: data.ttl().keyHash(),
        }),
      );
    default:
      throw new Error(`Unsupported LedgerEntry arm: ${arm}`);
  }
}

/**
 * Extract declared read-only and read-write footprint keys from transaction envelope sorobanData.
 */
export function extractFootprint(tx: xdr.Transaction): { readOnly: string[]; readWrite: string[] } {
  try {
    const ext = tx.ext();
    const extArm = (ext as any).arm ? (ext as any).arm() : (ext as any).switch?.()?.name;
    if (extArm === 'sorobanData' || (ext as any).sorobanData) {
      const sorobanData = ext.sorobanData();
      const fp = sorobanData.resources().footprint();
      return {
        readOnly: fp.readOnly().map((k) => k.toXDR('base64')),
        readWrite: fp.readWrite().map((k) => k.toXDR('base64')),
      };
    }
  } catch {
    // Ext without sorobanData or malformed
  }
  return { readOnly: [], readWrite: [] };
}

/**
 * Extract modified ledger keys from transaction result meta (supporting v3 and v4).
 * Returns base64 LedgerKeys or null if meta was unavailable or invalid.
 */
export function extractChangedKeys(metaXdr: string | xdr.TransactionMeta): string[] | null {
  try {
    const meta = typeof metaXdr === 'string' ? xdr.TransactionMeta.fromXDR(metaXdr, 'base64') : metaXdr;
    const changedKeys = new Set<string>();

    const processChanges = (changes: xdr.LedgerEntryChange[]) => {
      for (const ch of changes) {
        // A single unsupported LedgerKey arm (e.g. configSetting, which
        // ledgerEntryToLedgerKey doesn't cover) must not discard every other
        // key already collected for this transaction — `changed: null` means
        // "meta wasn't available", not "one entry type wasn't recognized".
        try {
          // The real LedgerEntryChangeType arm names are the full XDR enum
          // members (`ledgerEntryCreated`, `ledgerEntryUpdated`,
          // `ledgerEntryRemoved`, `ledgerEntryState`, `ledgerEntryRestored`),
          // not their bare suffixes. A presence-check like `(ch as any).created`
          // is useless as a fallback: the accessor method exists on every
          // instance regardless of which arm is active (it throws "not set"
          // when called on the wrong one), so it is always truthy and would
          // silently misclassify every change as a create.
          switch (ch.switch().name) {
            case 'ledgerEntryCreated':
              changedKeys.add(ledgerEntryToLedgerKey(ch.created()).toXDR('base64'));
              break;
            case 'ledgerEntryUpdated':
              changedKeys.add(ledgerEntryToLedgerKey(ch.updated()).toXDR('base64'));
              break;
            case 'ledgerEntryRemoved':
              // removed() already returns a LedgerKey, not a LedgerEntry.
              changedKeys.add(ch.removed().toXDR('base64'));
              break;
            case 'ledgerEntryRestored':
              changedKeys.add(ledgerEntryToLedgerKey(ch.restored()).toXDR('base64'));
              break;
            case 'ledgerEntryState':
              // The entry was read, not changed — nothing to record.
              break;
          }
        } catch (err) {
          logger.debug({ error: String(err) }, 'invocations.unsupportedLedgerEntryArm');
        }
      }
    };

    // `meta.switch()` is the raw discriminant (an int for TransactionMeta), so
    // `.name` on it is undefined; `.arm()` resolves the actual arm identifier
    // and is what must be switched on. Checking `arm === 'v3'` first with an
    // `|| (meta as any).v3` fallback is a trap: `.v3` is a bound accessor
    // method that exists on every TransactionMeta instance regardless of
    // which arm is active, so it is always truthy and the v3 branch would
    // wrongly run — and throw — for every v4 meta (the current, common case),
    // since the else-if for v4 is then never reached.
    switch (meta.switch()) {
      case 3: {
        const v3 = meta.v3();
        processChanges(v3.txChangesBefore());
        for (const op of v3.operations()) {
          processChanges(op.changes());
        }
        processChanges(v3.txChangesAfter());
        return Array.from(changedKeys);
      }
      case 4: {
        const v4 = meta.v4();
        processChanges(v4.txChangesBefore());
        for (const op of v4.operations()) {
          processChanges(op.changes());
        }
        processChanges(v4.txChangesAfter());
        return Array.from(changedKeys);
      }
      default:
        return [];
    }
  } catch (err) {
    logger.debug({ error: String(err) }, 'invocations.extractChangedKeysFailed');
    return null;
  }
}

/**
 * Extract all contract IDs that emitted events or diagnostic events in this transaction.
 */
export function extractEventsContractIds(metaXdr: string | xdr.TransactionMeta): string[] {
  try {
    const meta = typeof metaXdr === 'string' ? xdr.TransactionMeta.fromXDR(metaXdr, 'base64') : metaXdr;
    const contractIds = new Set<string>();

    const addEvent = (event: xdr.ContractEvent) => {
      const cid = event.contractId();
      if (cid) {
        contractIds.add(Address.contract(cid as any).toString());
      }
    };

    // See extractChangedKeys: switch on the resolved discriminant, not a
    // string-literal check with an always-truthy accessor-presence fallback,
    // or the v3 branch wrongly wins for every v4 meta and throws.
    switch (meta.switch()) {
      case 3: {
        const v3 = meta.v3();
        const sorobanMeta = v3.sorobanMeta();
        if (sorobanMeta) {
          for (const ev of sorobanMeta.events()) {
            addEvent(ev);
          }
          for (const dev of sorobanMeta.diagnosticEvents()) {
            addEvent(dev.event());
          }
        }
        break;
      }
      case 4: {
        const v4 = meta.v4();
        for (const ev of v4.events()) {
          addEvent(ev.event());
        }
        for (const dev of v4.diagnosticEvents()) {
          addEvent(dev.event());
        }
        break;
      }
    }
    return Array.from(contractIds);
  } catch {
    return [];
  }
}

/**
 * Extract source account public key (G...) from transaction envelope.
 */
export function extractSourceAccount(envelope: xdr.TransactionEnvelope): string {
  const arm = (envelope as any).arm ? (envelope as any).arm() : (envelope as any).switch?.()?.name;
  let tx: xdr.Transaction;
  if (arm === 'v1' || (envelope as any).v1) {
    tx = envelope.v1().tx();
  } else if (arm === 'feeBump' || (envelope as any).feeBump) {
    const inner = envelope.feeBump().tx().innerTx();
    tx = inner.v1().tx();
  } else if (arm === 'v0' || (envelope as any).v0) {
    return StrKey.encodeEd25519PublicKey(envelope.v0().tx().sourceAccountEd25519());
  } else {
    throw new Error(`Unsupported envelope arm: ${arm}`);
  }
  const sa = tx.sourceAccount();
  const saArm = (sa as any).arm ? (sa as any).arm() : (sa as any).switch?.()?.name;
  if (saArm === 'ed25519' || (sa as any).ed25519) {
    return StrKey.encodeEd25519PublicKey(sa.ed25519());
  } else if (saArm === 'med25519' || (sa as any).med25519) {
    return StrKey.encodeMed25519PublicKey(sa.med25519().ed25519());
  }
  return StrKey.encodeEd25519PublicKey(sa.value() as Buffer);
}

/**
 * Extract top-level invoked function name if the target of invokeHostFunction is this contract.
 * Invocations where the contract is reached only as a sub-call return null.
 */
export function extractFunctionName(tx: xdr.Transaction, contractAddress: string): string | null {
  try {
    for (const op of tx.operations()) {
      const body = op.body();
      const bodyArm = (body as any).arm ? (body as any).arm() : (body as any).switch?.()?.name;
      if (bodyArm === 'invokeHostFunctionOp' || (body as any).invokeHostFunctionOp) {
        const hostFn = body.invokeHostFunctionOp().hostFunction();
        const hostFnArm = (hostFn as any).arm ? (hostFn as any).arm() : (hostFn as any).switch?.()?.name;
        if (hostFnArm === 'invokeContract' || (hostFn as any).invokeContract) {
          const inv = hostFn.invokeContract();
          const target = Address.fromScAddress(inv.contractAddress()).toString();
          if (target === contractAddress) {
            return inv.functionName().toString();
          }
        }
      }
    }
  } catch {
    // Non-invoke op or malformed structure
  }
  return null;
}

/**
 * Per-contract invocation index capture worker.
 *
 * Discovers recent transactions for tracked contracts via RPC `getEvents` (documenting
 * the blind spot for event-less calls) and fetches full transaction details via `getTransaction`.
 * Decodes declared footprints, result meta state changes, and top-level function names.
 */
export async function runInvocationsWorker(
  soroban: SorobanInvocationsRpc,
  config: Pick<IndexerConfig, 'eventWindowLedgers'>,
  store: InvocationsStore,
): Promise<InvocationsResult> {
  const contracts = await store.contract.findMany({
    select: { id: true, address: true, wasmHash: true },
  });

  let invocationsUpserted = 0;
  let latestLedger = 0;
  try {
    const latestInfo = await withRetry(() => soroban.getLatestLedger(), { label: RETRY_LABEL });
    latestLedger = latestInfo.sequence;
  } catch (err) {
    logger.error({ error: String(err) }, 'invocations.latestLedgerFailed');
    return { invocationsUpserted: 0, contractsScanned: 0 };
  }

  for (const contract of contracts) {
    let stored = 0;
    try {
      const lastInv = await store.contractInvocation.findFirst({
        where: { contractId: contract.id },
        orderBy: { createdAt: 'desc' },
        select: { txHash: true, ledger: true },
      });

      let startLedger: number;
      if (lastInv && lastInv.ledger > 0) {
        startLedger = lastInv.ledger + 1;
        if (latestLedger - startLedger > config.eventWindowLedgers) {
          startLedger = Math.max(1, latestLedger - config.eventWindowLedgers);
        }
      } else {
        startLedger = Math.max(1, latestLedger - config.eventWindowLedgers);
      }

      if (startLedger > latestLedger) {
        continue;
      }

      const eventsRes = await withRetry(
        () =>
          soroban.getEvents({
            startLedger,
            filters: [{ type: 'contract', contractIds: [contract.address] }],
            limit: 100,
          }),
        { label: RETRY_LABEL },
      );
      await sleep(RATE_LIMIT_DELAY_MS);

      // Collect unique transaction hashes
      const txHashes: string[] = [];
      const seen = new Set<string>();
      for (const ev of eventsRes.events ?? []) {
        if (ev.txHash && !seen.has(ev.txHash)) {
          seen.add(ev.txHash);
          txHashes.push(ev.txHash);
        }
      }

      for (const txHash of txHashes) {
        let txRes: rpc.Api.GetTransactionResponse;
        try {
          txRes = await withRetry(
            () => soroban.getTransaction(txHash),
            { label: RETRY_LABEL },
          );
        } catch (err) {
          logger.warn({ txHash, error: String(err) }, 'invocations.getTransactionFailed');
          continue;
        }
        await sleep(RATE_LIMIT_DELAY_MS);

        if (txRes.status === 'NOT_FOUND' || (txRes as any).status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
          logger.debug({ txHash, contract: contract.address }, 'invocations.txExpired');
          continue;
        }

        const rawEnv = (txRes as any).envelopeXdr;
        if (!rawEnv) {
          logger.warn({ txHash }, 'invocations.missingEnvelopeXdr');
          continue;
        }

        let envelope: xdr.TransactionEnvelope;
        try {
          envelope = typeof rawEnv === 'string'
            ? xdr.TransactionEnvelope.fromXDR(rawEnv, 'base64')
            : rawEnv;
        } catch (err) {
          logger.warn({ txHash, error: String(err) }, 'invocations.malformedEnvelopeXdr');
          continue;
        }

        let tx: xdr.Transaction;
        try {
          const envArm = (envelope as any).arm ? (envelope as any).arm() : (envelope as any).switch?.()?.name;
          if (envArm === 'v1' || (envelope as any).v1) {
            tx = envelope.v1().tx();
          } else if (envArm === 'feeBump' || (envelope as any).feeBump) {
            tx = envelope.feeBump().tx().innerTx().v1().tx();
          } else {
            logger.warn({ txHash, arm: envArm }, 'invocations.unsupportedEnvelopeArm');
            continue;
          }
        } catch (err) {
          logger.warn({ txHash, error: String(err) }, 'invocations.malformedTxStructure');
          continue;
        }

        let sourceAccount: string;
        try {
          sourceAccount = extractSourceAccount(envelope);
        } catch (err) {
          logger.warn({ txHash, error: String(err) }, 'invocations.failedToExtractSourceAccount');
          continue;
        }

        const { readOnly, readWrite } = extractFootprint(tx);
        const fnName = extractFunctionName(tx, contract.address);
        const metaXdr = (txRes as any).resultMetaXdr;
        const changed = metaXdr ? extractChangedKeys(metaXdr) : null;
        const eventsContractIds = metaXdr ? extractEventsContractIds(metaXdr) : [];

        const createdAt = txRes.createdAt
          ? typeof txRes.createdAt === 'number'
            ? new Date(txRes.createdAt * 1000)
            : !isNaN(Number(txRes.createdAt))
              ? new Date(Number(txRes.createdAt) * 1000)
              : new Date(txRes.createdAt)
          : new Date();

        const successful =
          txRes.status === 'SUCCESS' || (txRes as any).status === rpc.Api.GetTransactionStatus.SUCCESS;

        const id = `${txHash}:0`;

        await store.contractInvocation.upsert({
          where: { id },
          update: {
            successful,
            wasmHash: contract.wasmHash,
            readOnly,
            readWrite,
            changed,
            eventsContractIds,
          },
          create: {
            id,
            contractId: contract.id,
            txHash,
            ledger: (txRes as any).ledger ?? 0,
            createdAt,
            sourceAccount,
            function: fnName,
            successful,
            wasmHash: contract.wasmHash,
            readOnly,
            readWrite,
            changed,
            callEdges: null,
            eventsContractIds,
          },
        });
        stored++;
      }
    } catch (err) {
      logger.error({ contract: contract.address, error: String(err) }, 'invocations.contractScanFailed');
    }
    invocationsUpserted += stored;
  }

  return { invocationsUpserted, contractsScanned: contracts.length };
}
