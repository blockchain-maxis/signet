import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  xdr,
  StrKey,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk';

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

const FRIENDBOT_URL = 'https://friendbot.stellar.org';

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

const wanted = (name: string) => ONLY.size === 0 || ONLY.has(name);

async function writeFixture(
  name: string,
  envelope: FixtureEnvelope,
  { always = false }: { always?: boolean } = {},
): Promise<void> {
  if (!always && !wanted(name)) return;
  await mkdir(DATA_DIR, { recursive: true });
  const path = join(DATA_DIR, `${name}.json`);
  await writeFile(path, JSON.stringify(envelope, null, 2) + '\n');
  console.log(`✓ Captured fixture: ${name}.json`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fund a fresh account through Friendbot's HTTP endpoint. A request can fund
 * the account and still fail client-side, after which Friendbot answers
 * "already funded", so success is judged by the account existing.
 */
async function friendbot(server: rpc.Server, address: string): Promise<void> {
  let lastError = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(address)}`);
      if (res.ok) return;
      lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    } catch (err) {
      lastError = String((err as { cause?: unknown }).cause ?? err);
    }
    try {
      await server.getAccount(address);
      return;
    } catch {
      // not funded yet; retry
    }
    await sleep(3000);
  }
  throw new Error(`Friendbot did not fund ${address}: ${lastError}`);
}

/**
 * Build, simulate, sign and submit one registry call as `signer`, then wait
 * for it to land. Returns the raw `getTransaction` result (the JSON the RPC
 * served, not the SDK's parsed form), which must be SUCCESS.
 */
async function invokeRegistry(
  server: rpc.Server,
  signer: Keypair,
  method: string,
  args: xdr.ScVal[],
): Promise<any> {
  const account = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(REGISTRY_CONTRACT_ID).call(method, ...args))
    .setTimeout(60)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status !== 'PENDING' && sent.status !== 'DUPLICATE') {
    throw new Error(`${method}: sendTransaction returned ${sent.status}`);
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await rpcCall('getTransaction', { hash: sent.hash });
    if (result.status === 'SUCCESS') return result;
    if (result.status !== 'NOT_FOUND') {
      throw new Error(`${method} ${sent.hash} ended ${result.status}`);
    }
    await sleep(2000);
  }
  throw new Error(`${method} ${sent.hash} did not land within 60s`);
}

/** `{kind, handle, wallet}` for a registry event as getEvents serves it (base64 XDR). */
function decodeRegistryEvent(event: { topic: string[]; value: string }) {
  const topics = event.topic.map((t) => xdr.ScVal.fromXDR(t, 'base64'));
  return {
    kind: String(scValToNative(topics[0]!)),
    handle: String(scValToNative(topics[1]!)),
    wallet: String(scValToNative(xdr.ScVal.fromXDR(event.value, 'base64'))),
  };
}

/**
 * Registry event stream: a fresh testnet account claims a random handle on
 * the registry and releases it, then records the getEvents page that holds
 * both events and the claim's getTransaction. Submits two real testnet
 * transactions. Both fixtures describe the same claim, so they are always
 * written together, and only after both events are confirmed in the page.
 */
async function captureRegistryEvents(): Promise<void> {
  const server = new rpc.Server(RPC_URL);
  const signer = Keypair.random();
  const wallet = signer.publicKey();
  const handle = `fx-${randomBytes(4).toString('hex')}`;

  console.log(`→ funding ${wallet} through Friendbot`);
  await friendbot(server, wallet);

  console.log(`→ claim(${handle}) and release(${handle}) on ${REGISTRY_CONTRACT_ID}`);
  const claimArgs = [
    nativeToScVal(handle, { type: 'string' }),
    Address.fromString(wallet).toScVal(),
  ];
  const claimTx = await invokeRegistry(server, signer, 'claim', claimArgs);
  const releaseTx = await invokeRegistry(server, signer, 'release', [
    nativeToScVal(handle, { type: 'string' }),
  ]);

  const params = {
    startLedger: claimTx.ledger,
    filters: [{ type: 'contract', contractIds: [REGISTRY_CONTRACT_ID] }],
    pagination: { limit: 100 },
  };
  const events = await rpcCall('getEvents', params);
  const ours = (events.events ?? []).filter(
    (e: { topic: string[]; value: string }) => decodeRegistryEvent(e).handle === handle,
  );
  const kinds = ours.map((e: { topic: string[]; value: string }) => decodeRegistryEvent(e).kind);
  if (
    kinds.join(',') !== 'claimed,released' ||
    ours[0].txHash !== claimTx.txHash ||
    ours[1].txHash !== releaseTx.txHash
  ) {
    throw new Error(
      `getEvents from ledger ${claimTx.ledger} did not return claimed then released for ${handle} ` +
        `(saw: ${kinds.join(',') || 'none'}); nothing written`,
    );
  }

  const capturedAt = new Date().toISOString();
  await writeFixture(
    'registry-claim-release-get-events',
    {
      network: NETWORK,
      rpcUrl: RPC_URL,
      capturedAt,
      latestLedger: events.latestLedger,
      request: { endpoint: 'rpc', methodOrPath: 'getEvents', params },
      payload: events,
    },
    { always: true },
  );
  await writeFixture(
    'claim-get-transaction',
    {
      network: NETWORK,
      rpcUrl: RPC_URL,
      capturedAt,
      latestLedger: claimTx.latestLedger,
      request: {
        endpoint: 'rpc',
        methodOrPath: 'getTransaction',
        params: { hash: claimTx.txHash },
      },
      payload: claimTx,
    },
    { always: true },
  );
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

  // 4. Registry event stream + the claim's getTransaction, from a fresh
  // claim/release (two real testnet transactions). Skipped unless one of its
  // fixtures is wanted, so `capture <other>` does not submit anything.
  if (wanted('registry-claim-release-get-events') || wanted('claim-get-transaction')) {
    await captureRegistryEvents();
  }

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
  if (!wanted('horizon-contract-deploy-tx')) {
    console.log('Capture completed successfully.');
    return;
  }
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

  console.log('Capture completed successfully.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
