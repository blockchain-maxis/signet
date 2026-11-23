import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { xdr, StrKey } from '@stellar/stellar-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'data');

const NETWORK = 'testnet';
const RPC_URL = process.env.INDEXER_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const HORIZON_URL = process.env.INDEXER_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';

const REGISTRY_CONTRACT_ID =
  process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID ??
  'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';

// Native XLM SAC contract id on testnet
const SAC_CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

// Known real claim transaction on testnet
const CLAIM_TX_HASH = 'ce05dc2ae700d2ea1d535d9efda77a212978d456c1a3e3da6e5f066a7008cd3d';

// Real create-contract (HostFunctionTypeCreateContract) transaction on testnet.
// Soroban RPC only serves getTransaction for a retention window (about 7 days),
// so when this hash ages out, pick a newer create-contract tx and update it.
const DEPLOY_TX_HASH = 'dd8155932d72fe2f8edc2405fc28c022212d79485bb56515fc3175259cf3c9b2';

// Real cross-contract calls on testnet (#516), both into the same lending
// contract (CBXZBQ6N…). The repay's auth tree names a sub-call to a Stellar
// Asset Contract `transfer`; the borrow touches a foreign contract instance
// (CAITA5YI…) that appears only in the footprint — neither the auth tree nor
// any contract event names it.
const SAC_TRANSFER_CALL_TX_HASH =
  '8267711dde3fd5b84b9314c6f771c0e5a427d60595856314b28c6b9049d92f13';
const FOOTPRINT_ONLY_CALL_TX_HASH =
  '7e8b80aa4dd8afe649b1362e1e4a79e9f931c8eeeb2deb8ccaa9e27aec224ac0';

// The account that sent DEPLOY_TX_HASH (#974). Its history is 313 operations,
// all on 2026-09-26: its funding, then contracts it deployed and called.
const DEPLOYER = 'GC6IQQHUT4BXZYCJEM4AOKFD6ASWSXCEDXYPVA5NFKXSGOSRJX72KJMC';
// The paging token of the deployer's fifth operation. What is older than it is
// its first four: the funding, a create-contract (V2), and two calls to the
// contract that created.
const DEPLOYER_FIRST_PAGE_CURSOR = '20988414253887489';
// The create-contract (V2) among those four.
const CREATE_V2_TX_HASH = 'be5118188b1dd3c516a62999b41476121e622d0e343094410684d5562bb2c997';
// The operation of DEPLOY_TX_HASH.
const DEPLOY_OPERATION_ID = '20989380621512705';

// `capture <name>...` re-records only the named fixtures, so adding one does
// not force re-capturing pinned transactions that have aged out of retention.
const ONLY = new Set(process.argv.slice(2));

async function rpcCall(method: string, params: unknown): Promise<any> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const data = await res.json();
      if (data && data.result) return data.result;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`RPC call ${method} failed after 10 attempts`);
}

async function horizonGet(path: string): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(HORIZON_URL + path);
      if (res.ok) return await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Horizon GET ${path} failed after 5 attempts`);
}

export interface FixtureEnvelope<T = unknown> {
  network: string;
  rpcUrl: string;
  capturedAt: string;
  latestLedger: number;
  request: {
    endpoint: 'rpc' | 'horizon';
    methodOrPath: string;
    params?: unknown;
  };
  payload: T;
}

async function writeFixture(name: string, envelope: FixtureEnvelope): Promise<void> {
  if (ONLY.size > 0 && !ONLY.has(name)) return;
  await mkdir(DATA_DIR, { recursive: true });
  const path = join(DATA_DIR, `${name}.json`);
  await writeFile(path, JSON.stringify(envelope, null, 2) + '\n');
  console.log(`✓ Captured fixture: ${name}.json`);
}

async function main() {
  console.log('Capturing testnet fixtures from', RPC_URL, 'and', HORIZON_URL);

  const latestLedgerInfo = await rpcCall('getLatestLedger', null);
  const latestLedger = latestLedgerInfo.sequence;
  const capturedAt = new Date().toISOString();

  // 1. Identity Registry instance entry
  const regBytes = StrKey.decodeContract(REGISTRY_CONTRACT_ID);
  const regKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: xdr.ScAddress.scAddressTypeContract(regBytes as never),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  ).toXDR('base64');
  const regEntries = await rpcCall('getLedgerEntries', { keys: [regKey] });
  await writeFixture('registry-instance-entry', {
    network: NETWORK,
    rpcUrl: RPC_URL,
    capturedAt,
    latestLedger,
    request: {
      endpoint: 'rpc',
      methodOrPath: 'getLedgerEntries',
      params: { keys: [regKey] },
    },
    payload: regEntries,
  });

  // 2. SAC instance entry
  const sacBytes = StrKey.decodeContract(SAC_CONTRACT_ID);
  const sacKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: xdr.ScAddress.scAddressTypeContract(sacBytes as never),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  ).toXDR('base64');
  const sacEntries = await rpcCall('getLedgerEntries', { keys: [sacKey] });
  await writeFixture('sac-instance-entry', {
    network: NETWORK,
    rpcUrl: RPC_URL,
    capturedAt,
    latestLedger,
    request: {
      endpoint: 'rpc',
      methodOrPath: 'getLedgerEntries',
      params: { keys: [sacKey] },
    },
    payload: sacEntries,
  });

  // 3. Contract WASM entry
  const entryXdr = regEntries.entries[0].xdr;
  const le = xdr.LedgerEntryData.fromXDR(entryXdr, 'base64');
  const wasmHash = le.contractData().val().instance().executable().wasmHash();
  const wasmKey = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: wasmHash }),
  ).toXDR('base64');
  const wasmEntries = await rpcCall('getLedgerEntries', { keys: [wasmKey] });
  await writeFixture('contract-wasm-entry', {
    network: NETWORK,
    rpcUrl: RPC_URL,
    capturedAt,
    latestLedger,
    request: {
      endpoint: 'rpc',
      methodOrPath: 'getLedgerEntries',
      params: { keys: [wasmKey] },
    },
    payload: wasmEntries,
  });

  // 4. Identity Registry claim getTransaction
  const claimTx = await rpcCall('getTransaction', { hash: CLAIM_TX_HASH });
  await writeFixture('claim-get-transaction', {
    network: NETWORK,
    rpcUrl: RPC_URL,
    capturedAt,
    latestLedger,
    request: {
      endpoint: 'rpc',
      methodOrPath: 'getTransaction',
      params: { hash: CLAIM_TX_HASH },
    },
    payload: claimTx,
  });

  // 5. Contract deployment getTransaction
  const deployTx = await rpcCall('getTransaction', { hash: DEPLOY_TX_HASH });
  await writeFixture('deploy-get-transaction', {
    network: NETWORK,
    rpcUrl: RPC_URL,
    capturedAt,
    latestLedger,
    request: {
      endpoint: 'rpc',
      methodOrPath: 'getTransaction',
      params: { hash: DEPLOY_TX_HASH },
    },
    payload: deployTx,
  });

  // 6–7. Cross-contract call getTransactions
  for (const [name, hash] of [
    ['sac-transfer-call-get-transaction', SAC_TRANSFER_CALL_TX_HASH],
    ['footprint-only-call-get-transaction', FOOTPRINT_ONLY_CALL_TX_HASH],
  ] as const) {
    if (ONLY.size > 0 && !ONLY.has(name)) continue;
    const callTx = await rpcCall('getTransaction', { hash });
    await writeFixture(name, {
      network: NETWORK,
      rpcUrl: RPC_URL,
      capturedAt,
      latestLedger,
      request: {
        endpoint: 'rpc',
        methodOrPath: 'getTransaction',
        params: { hash },
      },
      payload: callTx,
    });
  }

  // 8. Horizon transaction record for the same deployment, verbatim. Current
  // Horizon does not return `result_meta_xdr`; the meta lives in the
  // `deploy-get-transaction` (RPC) fixture. Nothing is merged or invented here:
  // if Horizon is unreachable the capture fails.
  const horizonTx = await horizonGet(`/transactions/${DEPLOY_TX_HASH}`);
  await writeFixture('horizon-contract-deploy-tx', {
    network: NETWORK,
    rpcUrl: HORIZON_URL,
    capturedAt,
    latestLedger,
    request: {
      endpoint: 'horizon',
      methodOrPath: `/transactions/${DEPLOY_TX_HASH}`,
    },
    payload: horizonTx,
  });

  // 9–13. Horizon operation records (#974), verbatim, so that the workers that
  // read them are tested on what Horizon sends and not on a record written by
  // hand. Each is fetched only when it is being captured.
  const horizonFixture = async (
    name: string,
    path: string,
    check: (payload: any) => string | null,
  ): Promise<any> => {
    if (ONLY.size > 0 && !ONLY.has(name)) return null;
    const payload = await horizonGet(path);
    const wrong = check(payload);
    if (wrong)
      throw new Error(`${name}: ${wrong}. The pinned ids in capture.ts need another look.`);
    await writeFixture(name, {
      network: NETWORK,
      rpcUrl: HORIZON_URL,
      capturedAt,
      latestLedger,
      request: { endpoint: 'horizon', methodOrPath: path },
      payload,
    });
    return payload;
  };
  const records = (page: any): any[] => page?._embedded?.records ?? [];
  const isCreateV2 = (op: any) =>
    op.function === 'HostFunctionTypeHostFunctionTypeCreateContractV2';

  // 9. The deployer's newest page: what both workers ask for first.
  await horizonFixture(
    'horizon-account-operations-page',
    `/accounts/${DEPLOYER}/operations?order=desc&limit=50`,
    (page) =>
      records(page).length === 50 ? null : `expected 50 records, got ${records(page).length}`,
  );

  // 10–11. The deployer's first four operations, and the empty page Horizon
  // answers with after them: the end of a backward walk.
  const firstPagePath = `/accounts/${DEPLOYER}/operations?cursor=${DEPLOYER_FIRST_PAGE_CURSOR}&limit=50&order=desc`;
  const firstPage = await horizonFixture(
    'horizon-account-operations-first-page',
    firstPagePath,
    (page) => {
      const ops = records(page);
      if (ops.length !== 4) return `expected the deployer's first 4 operations, got ${ops.length}`;
      if (!ops.some((op) => isCreateV2(op) && op.transaction_hash === CREATE_V2_TX_HASH))
        return 'no create-contract (V2) record for the pinned transaction';
      if (ops[ops.length - 1].type !== 'create_account')
        return 'the oldest record is not the funding';
      return null;
    },
  );
  if (ONLY.size === 0 || ONLY.has('horizon-account-operations-end')) {
    // The next link of the page above, as Horizon wrote it.
    const page = firstPage ?? (await horizonGet(firstPagePath));
    const next = new URL(page._links.next.href);
    await horizonFixture('horizon-account-operations-end', next.pathname + next.search, (end) =>
      records(end).length === 0 ? null : `expected no records, got ${records(end).length}`,
    );
  }

  // 12. The transaction of that create-contract (V2) operation.
  await horizonFixture(
    'horizon-create-contract-v2-tx',
    `/transactions/${CREATE_V2_TX_HASH}`,
    (tx) => (tx.hash === CREATE_V2_TX_HASH ? null : 'not the pinned transaction'),
  );

  // 13. The operation of DEPLOY_TX_HASH, whose transaction the fixtures above
  // record twice (`horizon-contract-deploy-tx`, `deploy-get-transaction`).
  await horizonFixture(
    'horizon-create-contract-operation',
    `/operations/${DEPLOY_OPERATION_ID}`,
    (op) =>
      op.transaction_hash === DEPLOY_TX_HASH
        ? null
        : 'not the operation of the recorded deployment',
  );

  console.log('Capture completed successfully.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
