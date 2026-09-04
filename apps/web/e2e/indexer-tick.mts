/**
 * Runs the real indexer workers once, against the real database, with Horizon
 * stubbed. Spawned as a subprocess by `claim-link-profile.spec.ts` — not a
 * Playwright spec itself (its filename does not match `*.spec.ts`, so the
 * runner ignores it).
 *
 * A subprocess rather than an import because these are the *indexer's* modules:
 * they resolve their own siblings through `.js` specifiers and expect the
 * indexer's dependency tree, so they are loaded the way the indexer loads them
 * rather than through the web app's Playwright transform.
 *
 * Horizon is the only stub. The workers, their pagination, their idempotency,
 * their dedup and every row they write are real — which is the point: a test
 * that reimplemented what the workers write would pass whatever they actually
 * did.
 *
 * Usage: node --import tsx apps/web/e2e/indexer-tick.ts <deployerPubkey> <contractAddress>
 */
import { randomBytes } from 'node:crypto';
import { xdr, StrKey, type Horizon } from '@stellar/stellar-sdk';
import { prisma } from '@signet/db';
import { runOperationsWorker } from '../../indexer/src/workers/operations.ts';
import { runDeploymentWorker } from '../../indexer/src/workers/deployment.ts';

const [deployer, contractAddress] = process.argv.slice(2);
if (!deployer || !contractAddress) {
  console.error('usage: indexer-tick.ts <deployerPubkey> <contractAddress>');
  process.exit(2);
}

// Unique per invocation. The deployment worker dedups on `deployTxHash` and
// the operations worker upserts on the Horizon op id, so fixed values made a
// re-run (Playwright retries into the same database) look like an operation
// already recorded: the second run found 0 contracts and left the first run's
// row in place.
const TX_HASH = randomBytes(32).toString('hex');
const OP_ID = String(4_000_000_000_000_000n + BigInt('0x' + randomBytes(4).toString('hex')));
const CREATED_AT = new Date().toISOString();

/**
 * The transaction meta Horizon returns for a contract creation: the Soroban
 * return value is the new contract's address, which is how the deployment
 * worker learns what was deployed.
 */
function contractCreationMetaXdr(address: string): string {
  const contractId = StrKey.decodeContract(address);
  const scAddress = xdr.ScAddress.scAddressTypeContract(
    contractId as unknown as Parameters<typeof xdr.ScAddress.scAddressTypeContract>[0],
  );
  const sorobanMeta = new xdr.SorobanTransactionMeta({
    ext: new xdr.SorobanTransactionMetaExt(0),
    events: [],
    returnValue: xdr.ScVal.scvAddress(scAddress),
    diagnosticEvents: [],
  });
  const v3 = new xdr.TransactionMetaV3({
    ext: new xdr.ExtensionPoint(0),
    txChangesBefore: [],
    operations: [],
    txChangesAfter: [],
    sorobanMeta,
  });
  return new xdr.TransactionMeta(3, v3).toXDR('base64');
}

/**
 * One `invoke_host_function` operation, deploying a contract. Both workers read
 * the same operation — that is what a real deployment looks like to them — so
 * one stub serves both: `operations` stores it as profile activity, `deployment`
 * recognises `HostFunctionTypeCreateContract` and records the contract.
 */
const deployOp = {
  id: OP_ID,
  type: 'invoke_host_function',
  function: 'HostFunctionTypeCreateContract',
  source_account: deployer,
  created_at: CREATED_AT,
  transaction_hash: TX_HASH,
  transaction_successful: true,
  paging_token: OP_ID,
};

function page(records: unknown[]) {
  return { records, next: async () => page([]) };
}

const horizon = {
  operations: () => ({
    forAccount: (account: string) => ({
      order: () => ({
        limit: () => ({
          // Only the linked deploy wallet has this operation; every other
          // wallet the workers walk sees an empty history, as it would.
          call: async () => page(account === deployer ? [deployOp] : []),
          cursor: () => ({ call: async () => page([]) }),
        }),
      }),
    }),
  }),
  transactions: () => ({
    transaction: () => ({
      call: async () => ({
        result_meta_xdr: contractCreationMetaXdr(contractAddress),
        ledger_attr: 2,
        created_at: CREATED_AT,
      }),
    }),
  }),
} as unknown as Horizon.Server;

const config = { network: 'testnet' } as Parameters<typeof runDeploymentWorker>[1];

try {
  const operations = await runOperationsWorker(horizon, prisma as never);
  const deployments = await runDeploymentWorker(horizon, config, prisma as never);
  console.log(JSON.stringify({ ok: true, operations, deployments }));
} catch (err) {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
