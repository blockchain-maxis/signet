import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { xdr, StrKey } from '@stellar/stellar-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');
const RPC_URL = process.env.INDEXER_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const NETWORK = 'testnet';

export interface FixtureManifestEntry {
  file: string;
  sourceContract: string;
  network: string;
  wasmHash: string;
  bytes: number;
  fetchedAt: string;
}

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

export async function fetchFixture(contractAddress: string, fixtureName: string): Promise<FixtureManifestEntry> {
  mkdirSync(FIXTURES_DIR, { recursive: true });

  const regBytes = StrKey.decodeContract(contractAddress);
  const regKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: xdr.ScAddress.scAddressTypeContract(regBytes as never),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  ).toXDR('base64');

  const regEntries = await rpcCall('getLedgerEntries', { keys: [regKey] });
  if (!regEntries?.entries?.[0]?.xdr) {
    throw new Error(`Contract instance entry not found for ${contractAddress}`);
  }

  const le = xdr.LedgerEntryData.fromXDR(regEntries.entries[0].xdr, 'base64');
  const wasmHashBuf = le.contractData().val().instance().executable().wasmHash();
  const wasmKey = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: wasmHashBuf }),
  ).toXDR('base64');

  const wasmEntries = await rpcCall('getLedgerEntries', { keys: [wasmKey] });
  if (!wasmEntries?.entries?.[0]?.xdr) {
    throw new Error(`WASM entry not found for hash ${wasmHashBuf.toString('hex')}`);
  }

  const wasmLe = xdr.LedgerEntryData.fromXDR(wasmEntries.entries[0].xdr, 'base64');
  const wasmBytes = wasmLe.contractCode().code();
  const sha256Hex = createHash('sha256').update(wasmBytes).digest('hex');

  const fileName = `${fixtureName}.wasm`;
  const filePath = join(FIXTURES_DIR, fileName);
  writeFileSync(filePath, wasmBytes);

  const manifestPath = join(FIXTURES_DIR, 'manifest.json');
  let manifest: Record<string, FixtureManifestEntry> = {};
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    manifest = {};
  }

  const manifestEntry: FixtureManifestEntry = {
    file: fileName,
    sourceContract: contractAddress,
    network: NETWORK,
    wasmHash: sha256Hex,
    bytes: wasmBytes.length,
    fetchedAt: new Date().toISOString(),
  };

  manifest[fixtureName] = manifestEntry;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`✓ Fetched fixture '${fileName}' (${wasmBytes.length} bytes, sha256: ${sha256Hex})`);
  return manifestEntry;
}

// If invoked as CLI script: fetch-fixture.ts <address> <name>
const args = process.argv.slice(2);
if (args.length >= 2) {
  const [address, name] = args;
  fetchFixture(address!, name!).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
