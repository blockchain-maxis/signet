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
export const DEFAULT_DATA_DIR = join(__dirname, '..', 'data');

export const DEFAULT_RPC_URL = process.env.INDEXER_RPC_URL ?? 'https://soroban-testnet.stellar.org';
export const DEFAULT_HORIZON_URL =
  process.env.INDEXER_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';

export const REGISTRY_CONTRACT_ID =
  process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID ??
  'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';

// Native XLM SAC contract id on testnet
export const SAC_CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

const FRIENDBOT_URL = 'https://friendbot.stellar.org';

// Real create-contract (HostFunctionTypeCreateContract) transaction on testnet.
// Soroban RPC only serves getTransaction for a retention window (about 7 days),
// so when this hash ages out, pick a newer create-contract tx and update it.
export const DEPLOY_TX_HASH = 'dd8155932d72fe2f8edc2405fc28c022212d79485bb56515fc3175259cf3c9b2';

// Real cross-contract calls on testnet (#516), both into the same lending
// contract (CBXZBQ6N…). The repay's auth tree names a sub-call to a Stellar
// Asset Contract `transfer`; the borrow touches a foreign contract instance
// (CAITA5YI…) that appears only in the footprint — neither the auth tree nor
// any contract event names it.
export const SAC_TRANSFER_CALL_TX_HASH =
  '8267711dde3fd5b84b9314c6f771c0e5a427d60595856314b28c6b9049d92f13';
export const FOOTPRINT_ONLY_CALL_TX_HASH =
  '7e8b80aa4dd8afe649b1362e1e4a79e9f931c8eeeb2deb8ccaa9e27aec224ac0';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One JSON-RPC call. A transport failure, a JSON-RPC `error` or a response
 * with no `result` is retried with exponential backoff (capped at 10s).
 */
export async function rpcCall(
  method: string,
  params: unknown,
  rpcUrl: string = DEFAULT_RPC_URL,
  maxAttempts: number = 10,
  initialDelayMs: number = 1000,
): Promise<any> {
  let delay = initialDelayMs;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const data = await res.json();
      if (data && data.error) {
        throw new Error(`RPC call ${method} returned error: ${JSON.stringify(data.error)}`);
      }
      if (data && 'result' in data) {
        return data.result;
      }
      throw new Error(`RPC call ${method} response missing result field`);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        await sleep(delay);
        delay = Math.min(delay * 2, 10000);
      }
    }
  }
  throw new Error(
    `RPC call ${method} failed after ${maxAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export async function horizonGet(
  path: string,
  horizonUrl: string = DEFAULT_HORIZON_URL,
  maxAttempts: number = 5,
  initialDelayMs: number = 1000,
): Promise<any> {
  let delay = initialDelayMs;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(horizonUrl + path);
      if (res.ok) return await res.json();
      throw new Error(`Horizon GET ${path} HTTP ${res.status} ${res.statusText}`);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        await sleep(delay);
        delay = Math.min(delay * 2, 5000);
      }
    }
  }
  throw new Error(
    `Horizon GET ${path} failed after ${maxAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
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

interface StagedFixture {
  name: string;
  envelope: FixtureEnvelope;
}

export interface CaptureOptions {
  /** Fixture names to re-record; empty records everything. */
  only?: Set<string>;
  dataDir?: string;
  rpcUrl?: string;
  horizonUrl?: string;
  initialRetryDelayMs?: number;
}

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
 * served, not the SDK's parsed form), which must be SUCCESS. `NOT_FOUND` here
 * means "not landed yet", so it is polled, not treated as aged out.
 */
async function invokeRegistry(
  server: rpc.Server,
  rpcUrl: string,
  retryDelay: number,
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
    const result = await rpcCall('getTransaction', { hash: sent.hash }, rpcUrl, 10, retryDelay);
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
 * the registry and releases it, then returns the getEvents page that holds
 * both events and the claim's getTransaction. Submits two real testnet
 * transactions. Both fixtures describe the same claim, so they are always
 * staged together, and only after both events are confirmed in the page.
 */
async function captureRegistryEvents(
  network: string,
  rpcUrl: string,
  retryDelay: number,
  capturedAt: string,
): Promise<StagedFixture[]> {
  const server = new rpc.Server(rpcUrl);
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
  const claimTx = await invokeRegistry(server, rpcUrl, retryDelay, signer, 'claim', claimArgs);
  const releaseTx = await invokeRegistry(server, rpcUrl, retryDelay, signer, 'release', [
    nativeToScVal(handle, { type: 'string' }),
  ]);

  const params = {
    startLedger: claimTx.ledger,
    filters: [{ type: 'contract', contractIds: [REGISTRY_CONTRACT_ID] }],
    pagination: { limit: 100 },
  };
  const events = await rpcCall('getEvents', params, rpcUrl, 10, retryDelay);
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

  return [
    {
      name: 'registry-claim-release-get-events',
      envelope: {
        network,
        rpcUrl,
        capturedAt,
        latestLedger: events.latestLedger,
        request: { endpoint: 'rpc', methodOrPath: 'getEvents', params },
        payload: events,
      },
    },
    {
      name: 'claim-get-transaction',
      envelope: {
        network,
        rpcUrl,
        capturedAt,
        latestLedger: claimTx.latestLedger,
        request: {
          endpoint: 'rpc',
          methodOrPath: 'getTransaction',
          params: { hash: claimTx.txHash },
        },
        payload: claimTx,
      },
    },
  ];
}

/**
 * Record the requested fixtures. Everything is captured into memory first;
 * files are written only once every requested fixture has succeeded, so a
 * failure at any step leaves `data/` exactly as it was.
 */
export async function capture(options: CaptureOptions = {}): Promise<void> {
  const only = options.only ?? new Set<string>();
  const wanted = (name: string) => only.size === 0 || only.has(name);
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  const rpcUrl = options.rpcUrl ?? DEFAULT_RPC_URL;
  const horizonUrl = options.horizonUrl ?? DEFAULT_HORIZON_URL;
  const retryDelay = options.initialRetryDelayMs ?? 1000;

  console.log('Capturing fixtures from', rpcUrl, 'and', horizonUrl);

  // The fixtures are testnet recordings: refuse an RPC that serves anything else.
  const networkInfo = await rpcCall('getNetwork', null, rpcUrl, 10, retryDelay);
  if (!networkInfo || networkInfo.passphrase !== Networks.TESTNET) {
    throw new Error(
      `Refusing to capture: network passphrase "${networkInfo?.passphrase}" does not match testnet ("${Networks.TESTNET}")`,
    );
  }
  const network = 'testnet';

  const latestLedgerInfo = await rpcCall('getLatestLedger', null, rpcUrl, 10, retryDelay);
  const latestLedger = latestLedgerInfo.sequence;
  const capturedAt = new Date().toISOString();

  const staged: StagedFixture[] = [];
  function stage(name: string, envelope: FixtureEnvelope) {
    if (!wanted(name)) return;
    staged.push({ name, envelope });
  }

  // 1. Identity Registry instance entry (also the source of the WASM hash in 3)
  let regEntries: any;
  if (wanted('registry-instance-entry') || wanted('contract-wasm-entry')) {
    const regBytes = StrKey.decodeContract(REGISTRY_CONTRACT_ID);
    const regKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: xdr.ScAddress.scAddressTypeContract(regBytes as never),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    ).toXDR('base64');
    regEntries = await rpcCall('getLedgerEntries', { keys: [regKey] }, rpcUrl, 10, retryDelay);

    if (!regEntries?.entries?.length || !regEntries.entries[0]?.xdr) {
      throw new Error(
        `Identity Registry instance entry is missing for contract ${REGISTRY_CONTRACT_ID}`,
      );
    }

    stage('registry-instance-entry', {
      network,
      rpcUrl,
      capturedAt,
      latestLedger,
      request: {
        endpoint: 'rpc',
        methodOrPath: 'getLedgerEntries',
        params: { keys: [regKey] },
      },
      payload: regEntries,
    });
  }

  // 2. SAC instance entry
  if (wanted('sac-instance-entry')) {
    const sacBytes = StrKey.decodeContract(SAC_CONTRACT_ID);
    const sacKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: xdr.ScAddress.scAddressTypeContract(sacBytes as never),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    ).toXDR('base64');
    const sacEntries = await rpcCall(
      'getLedgerEntries',
      { keys: [sacKey] },
      rpcUrl,
      10,
      retryDelay,
    );
    stage('sac-instance-entry', {
      network,
      rpcUrl,
      capturedAt,
      latestLedger,
      request: {
        endpoint: 'rpc',
        methodOrPath: 'getLedgerEntries',
        params: { keys: [sacKey] },
      },
      payload: sacEntries,
    });
  }

  // 3. Contract WASM entry
  if (wanted('contract-wasm-entry')) {
    const entryXdr = regEntries.entries[0].xdr;
    const le = xdr.LedgerEntryData.fromXDR(entryXdr, 'base64');
    const wasmHash = le.contractData().val().instance().executable().wasmHash();
    const wasmKey = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: wasmHash }),
    ).toXDR('base64');
    const wasmEntries = await rpcCall(
      'getLedgerEntries',
      { keys: [wasmKey] },
      rpcUrl,
      10,
      retryDelay,
    );
    stage('contract-wasm-entry', {
      network,
      rpcUrl,
      capturedAt,
      latestLedger,
      request: {
        endpoint: 'rpc',
        methodOrPath: 'getLedgerEntries',
        params: { keys: [wasmKey] },
      },
      payload: wasmEntries,
    });
  }

  // A pinned hash that has aged out of RPC retention answers NOT_FOUND inside
  // `result`; anything but SUCCESS fails the whole capture, naming the
  // fixture and the hash, so a good recording is never replaced by it.
  async function fetchGetTransaction(fixtureName: string, hash: string): Promise<any> {
    const tx = await rpcCall('getTransaction', { hash }, rpcUrl, 10, retryDelay);
    if (!tx || tx.status !== 'SUCCESS') {
      throw new Error(
        `getTransaction for ${fixtureName} (${hash}) did not succeed: status is "${tx?.status ?? 'UNKNOWN'}"`,
      );
    }
    return tx;
  }

  // 4. Contract deployment getTransaction
  if (wanted('deploy-get-transaction')) {
    const deployTx = await fetchGetTransaction('deploy-get-transaction', DEPLOY_TX_HASH);
    stage('deploy-get-transaction', {
      network,
      rpcUrl,
      capturedAt,
      latestLedger,
      request: {
        endpoint: 'rpc',
        methodOrPath: 'getTransaction',
        params: { hash: DEPLOY_TX_HASH },
      },
      payload: deployTx,
    });
  }

  // 5–6. Cross-contract call getTransactions
  for (const [name, hash] of [
    ['sac-transfer-call-get-transaction', SAC_TRANSFER_CALL_TX_HASH],
    ['footprint-only-call-get-transaction', FOOTPRINT_ONLY_CALL_TX_HASH],
  ] as const) {
    if (!wanted(name)) continue;
    const callTx = await fetchGetTransaction(name, hash);
    stage(name, {
      network,
      rpcUrl,
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

  // 7. Horizon transaction record for the same deployment, verbatim. Current
  // Horizon does not return `result_meta_xdr`; the meta lives in the
  // `deploy-get-transaction` (RPC) fixture. Nothing is merged or invented here:
  // if Horizon is unreachable the capture fails.
  if (wanted('horizon-contract-deploy-tx')) {
    const horizonTx = await horizonGet(
      `/transactions/${DEPLOY_TX_HASH}`,
      horizonUrl,
      5,
      retryDelay,
    );
    stage('horizon-contract-deploy-tx', {
      network,
      rpcUrl: horizonUrl,
      capturedAt,
      latestLedger,
      request: {
        endpoint: 'horizon',
        methodOrPath: `/transactions/${DEPLOY_TX_HASH}`,
      },
      payload: horizonTx,
    });
  }

  // 8. Registry event stream + the claim's getTransaction, from a fresh
  // claim/release (two real testnet transactions). Runs last, so a read-only
  // failure above (an aged-out hash, Horizon down) stops the capture before
  // anything is submitted. Skipped unless one of its fixtures is wanted, so
  // `capture <other>` submits nothing; naming either records both.
  if (wanted('registry-claim-release-get-events') || wanted('claim-get-transaction')) {
    staged.push(...(await captureRegistryEvents(network, rpcUrl, retryDelay, capturedAt)));
  }

  // Every requested fixture succeeded: only now touch the data directory.
  await mkdir(dataDir, { recursive: true });
  for (const { name, envelope } of staged) {
    const path = join(dataDir, `${name}.json`);
    await writeFile(path, JSON.stringify(envelope, null, 2) + '\n');
    console.log(`✓ Captured fixture: ${name}.json`);
  }

  console.log('Capture completed successfully.');
}

// `capture <name>...` re-records only the named fixtures, so adding one does
// not force re-capturing pinned transactions that have aged out of retention.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  capture({ only: new Set(process.argv.slice(2)) }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
