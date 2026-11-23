import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { xdr, StrKey, Networks } from '@stellar/stellar-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const DEFAULT_DATA_DIR = join(__dirname, '..', 'data');

export const DEFAULT_RPC_URL =
  process.env.INDEXER_RPC_URL ?? 'https://soroban-testnet.stellar.org';
export const DEFAULT_HORIZON_URL =
  process.env.INDEXER_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';

export const REGISTRY_CONTRACT_ID =
  process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID ??
  'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';

// Native XLM SAC contract id on testnet
export const SAC_CONTRACT_ID =
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

// Known real claim transaction on testnet
export const CLAIM_TX_HASH =
  'ce05dc2ae700d2ea1d535d9efda77a212978d456c1a3e3da6e5f066a7008cd3d';

// Real create-contract (HostFunctionTypeCreateContract) transaction on testnet.
// Soroban RPC only serves getTransaction for a retention window (about 7 days),
// so when this hash ages out, pick a newer create-contract tx and update it.
export const DEPLOY_TX_HASH =
  'dd8155932d72fe2f8edc2405fc28c022212d79485bb56515fc3175259cf3c9b2';

// Real cross-contract calls on testnet (#516), both into the same lending
// contract (CBXZBQ6N…). The repay's auth tree names a sub-call to a Stellar
// Asset Contract `transfer`; the borrow touches a foreign contract instance
// (CAITA5YI…) that appears only in the footprint — neither the auth tree nor
// any contract event names it.
export const SAC_TRANSFER_CALL_TX_HASH =
  '8267711dde3fd5b84b9314c6f771c0e5a427d60595856314b28c6b9049d92f13';
export const FOOTPRINT_ONLY_CALL_TX_HASH =
  '7e8b80aa4dd8afe649b1362e1e4a79e9f931c8eeeb2deb8ccaa9e27aec224ac0';

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
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 10000);
      }
    }
  }
  throw new Error(`RPC call ${method} failed after ${maxAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
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
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 5000);
      }
    }
  }
  throw new Error(`Horizon GET ${path} failed after ${maxAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
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
  only?: Set<string>;
  dataDir?: string;
  rpcUrl?: string;
  horizonUrl?: string;
  initialRetryDelayMs?: number;
}

export async function capture(options: CaptureOptions = {}): Promise<void> {
  const only = options.only ?? new Set<string>();
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  const rpcUrl = options.rpcUrl ?? DEFAULT_RPC_URL;
  const horizonUrl = options.horizonUrl ?? DEFAULT_HORIZON_URL;
  const retryDelay = options.initialRetryDelayMs ?? 1000;

  console.log('Capturing fixtures from', rpcUrl, 'and', horizonUrl);

  // Validate network passphrase from getNetwork
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
    if (only.size > 0 && !only.has(name)) return;
    staged.push({ name, envelope });
  }

  // 1. Identity Registry instance entry
  const shouldCaptureReg = only.size === 0 || only.has('registry-instance-entry') || only.has('contract-wasm-entry');
  let regEntries: any;
  if (shouldCaptureReg) {
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
      throw new Error(`Identity Registry instance entry is missing for contract ${REGISTRY_CONTRACT_ID}`);
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
  if (only.size === 0 || only.has('sac-instance-entry')) {
    const sacBytes = StrKey.decodeContract(SAC_CONTRACT_ID);
    const sacKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: xdr.ScAddress.scAddressTypeContract(sacBytes as never),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    ).toXDR('base64');
    const sacEntries = await rpcCall('getLedgerEntries', { keys: [sacKey] }, rpcUrl, 10, retryDelay);
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
  if (only.size === 0 || only.has('contract-wasm-entry')) {
    if (!regEntries?.entries?.length || !regEntries.entries[0]?.xdr) {
      throw new Error(`Cannot capture contract-wasm-entry: Identity Registry instance entry is missing`);
    }
    const entryXdr = regEntries.entries[0].xdr;
    const le = xdr.LedgerEntryData.fromXDR(entryXdr, 'base64');
    const wasmHash = le.contractData().val().instance().executable().wasmHash();
    const wasmKey = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: wasmHash }),
    ).toXDR('base64');
    const wasmEntries = await rpcCall('getLedgerEntries', { keys: [wasmKey] }, rpcUrl, 10, retryDelay);
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

  // Helper for getTransaction: asserts status === 'SUCCESS'
  async function fetchGetTransaction(fixtureName: string, hash: string): Promise<any> {
    const tx = await rpcCall('getTransaction', { hash }, rpcUrl, 10, retryDelay);
    if (!tx || tx.status !== 'SUCCESS') {
      throw new Error(
        `getTransaction for ${fixtureName} (${hash}) did not succeed: status is "${tx?.status ?? 'UNKNOWN'}"`,
      );
    }
    return tx;
  }

  // 4. Identity Registry claim getTransaction
  if (only.size === 0 || only.has('claim-get-transaction')) {
    const claimTx = await fetchGetTransaction('claim-get-transaction', CLAIM_TX_HASH);
    stage('claim-get-transaction', {
      network,
      rpcUrl,
      capturedAt,
      latestLedger,
      request: {
        endpoint: 'rpc',
        methodOrPath: 'getTransaction',
        params: { hash: CLAIM_TX_HASH },
      },
      payload: claimTx,
    });
  }

  // 5. Contract deployment getTransaction
  if (only.size === 0 || only.has('deploy-get-transaction')) {
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

  // 6–7. Cross-contract call getTransactions
  for (const [name, hash] of [
    ['sac-transfer-call-get-transaction', SAC_TRANSFER_CALL_TX_HASH],
    ['footprint-only-call-get-transaction', FOOTPRINT_ONLY_CALL_TX_HASH],
  ] as const) {
    if (only.size > 0 && !only.has(name)) continue;
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

  // 8. Horizon transaction record for the same deployment
  if (only.size === 0 || only.has('horizon-contract-deploy-tx')) {
    const horizonTx = await horizonGet(`/transactions/${DEPLOY_TX_HASH}`, horizonUrl, 5, retryDelay);
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

  // All requested fixtures captured and validated successfully!
  // Write all staged fixtures atomically:
  await mkdir(dataDir, { recursive: true });
  for (const { name, envelope } of staged) {
    const path = join(dataDir, `${name}.json`);
    await writeFile(path, JSON.stringify(envelope, null, 2) + '\n');
    console.log(`✓ Captured fixture: ${name}.json`);
  }

  console.log('Capture completed successfully.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  capture({ only: new Set(process.argv.slice(2)) }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
