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

  // 6. Horizon transaction record for the same deployment, verbatim. Current
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

  console.log('Capture completed successfully.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
