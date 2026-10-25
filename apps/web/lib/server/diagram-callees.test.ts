import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Address, xdr } from '@stellar/stellar-sdk';
import nativeSac from '../../../../packages/fixtures/data/sac-instance-entry.json' with { type: 'json' };
import registryInstance from '../../../../packages/fixtures/data/registry-instance-entry.json' with { type: 'json' };
import { __resetCalleeLabels, labelCallees, type LedgerEntriesServer } from './diagram.ts';

// Real testnet instances: the native XLM SAC, and the identity registry (a
// WASM contract). The USDC SAC is the native one's entry with another
// address and the METADATA the host writes for a credit asset.
const NATIVE = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const REGISTRY = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const UNKNOWN = 'CAITA5YIDBY4WQU7C5DUOM2P6BWZDFCKFCGOSUVDHZH3O3T7XKOAYOZR';
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const entryData = (b64: string) => xdr.LedgerEntryData.fromXDR(b64, 'base64');

function usdcEntry(): xdr.LedgerEntryData {
  const native = entryData(nativeSac.payload.entries[0]!.xdr).contractData();
  const sym = (s: string) => xdr.ScVal.scvSymbol(s);
  const metadata = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: sym('decimal'), val: xdr.ScVal.scvU32(7) }),
    new xdr.ScMapEntry({ key: sym('name'), val: xdr.ScVal.scvString(`USDC:${ISSUER}`) }),
    new xdr.ScMapEntry({ key: sym('symbol'), val: xdr.ScVal.scvString('USDC') }),
  ]);
  const instance = new xdr.ScContractInstance({
    executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
    storage: [new xdr.ScMapEntry({ key: sym('METADATA'), val: metadata })],
  });
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: native.ext(),
      contract: new Address(USDC).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(instance),
    }),
  );
}

/** A stub RPC holding these instances; any other key is absent, as RPC answers. */
function stubServer(calls: string[][]): LedgerEntriesServer {
  const held = new Map<string, xdr.LedgerEntryData>([
    [NATIVE, entryData(nativeSac.payload.entries[0]!.xdr)],
    [REGISTRY, entryData(registryInstance.payload.entries[0]!.xdr)],
    [USDC, usdcEntry()],
  ]);
  return {
    async getLedgerEntries(...keys) {
      const addresses = keys.map((k) =>
        Address.fromScAddress(k.contractData().contract()).toString(),
      );
      calls.push(addresses);
      return {
        entries: addresses.flatMap((a, i) =>
          held.has(a) ? [{ key: keys[i]!, val: held.get(a)! }] : [],
        ),
      };
    },
  };
}

const realFetch = globalThis.fetch;
const realDb = process.env.DATABASE_URL;

beforeEach(() => {
  __resetCalleeLabels();
  // Labels come from chain data and Contract rows only: nothing else may be asked.
  globalThis.fetch = (async () => {
    throw new Error('labelCallees consulted the network outside its RPC dependency');
  }) as typeof fetch;
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realDb === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = realDb;
});

test('a SAC, a Signet-deployed contract and an unknown contract, from one batched read', async () => {
  const rpcCalls: string[][] = [];
  const dbCalls: string[][] = [];
  const labels = await labelCallees([USDC, NATIVE, REGISTRY, UNKNOWN, USDC], 'testnet', {
    server: stubServer(rpcCalls),
    findSignetContracts: async (addresses, network) => {
      dbCalls.push([...addresses, network]);
      return addresses.includes(REGISTRY) ? [{ address: REGISTRY, handle: 'alice' }] : [];
    },
  });

  assert.deepEqual(rpcCalls, [[USDC, NATIVE, REGISTRY, UNKNOWN]], 'one batch, each address once');
  assert.deepEqual(dbCalls, [[USDC, NATIVE, REGISTRY, UNKNOWN, 'testnet']]);

  assert.deepEqual(labels.get(USDC), {
    kind: 'asset',
    address: USDC,
    text: 'USDC (asset contract, issuer G…KZVN)',
    href: `https://stellar.expert/explorer/testnet/contract/${USDC}`,
  });
  assert.equal(labels.get(NATIVE)!.text, 'XLM (native asset contract)');
  assert.deepEqual(labels.get(REGISTRY), {
    kind: 'signet',
    address: REGISTRY,
    handle: 'alice',
    text: 'deployed by @alice',
    href: `/p/alice/contract/${REGISTRY}`,
  });
  assert.deepEqual(labels.get(UNKNOWN), {
    kind: 'address',
    address: UNKNOWN,
    text: 'CAIT…YOZR',
    href: `https://stellar.expert/explorer/testnet/contract/${UNKNOWN}`,
  });
});

test('chain identity is cached; Signet ownership is re-read on every call', async () => {
  const rpcCalls: string[][] = [];
  let owned = true;
  const deps = {
    server: stubServer(rpcCalls),
    findSignetContracts: async () => (owned ? [{ address: REGISTRY, handle: 'alice' }] : []),
  };
  await labelCallees([USDC, REGISTRY, UNKNOWN], 'testnet', deps);
  owned = false;
  const again = await labelCallees([USDC, REGISTRY, UNKNOWN], 'testnet', deps);

  // The unknown address had no instance: not cached, asked again.
  assert.deepEqual(rpcCalls, [[USDC, REGISTRY, UNKNOWN], [UNKNOWN]]);
  assert.equal(again.get(USDC)!.kind, 'asset');
  assert.equal(again.get(REGISTRY)!.kind, 'address', 'ownership gone, label gone');

  // Past the TTL the chain is read again.
  const later = { ...deps, now: () => Date.now() + 8 * 24 * 60 * 60 * 1000 };
  await labelCallees([USDC], 'testnet', later);
  assert.deepEqual(rpcCalls.at(-1), [USDC]);
});

test('RPC and database failures fall back to addresses, never to a guess', async () => {
  const labels = await labelCallees([USDC, REGISTRY], 'mainnet', {
    server: {
      async getLedgerEntries() {
        throw new Error('RPC down');
      },
    },
    findSignetContracts: async () => {
      throw new Error('db down');
    },
  });
  assert.deepEqual(
    [...labels.values()].map((l) => [l.kind, l.href]),
    [
      ['address', `https://stellar.expert/explorer/public/contract/${USDC}`],
      ['address', `https://stellar.expert/explorer/public/contract/${REGISTRY}`],
    ],
  );
});
