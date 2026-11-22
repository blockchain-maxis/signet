import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, xdr } from '@stellar/stellar-sdk';
import {
  ContractNotFound,
  InterfaceUnreadable,
  LruSpecCache,
  NoInterface,
  RpcUnavailable,
  WasmNotFound,
  type SpecJson,
} from '@signet/spec';
import type { GetContractSpecOptions, ResolvedContractSpec } from '@signet/spec/resolve';
import { loadContractSpec, specCaches, type ContractSpecDeps } from './contract-spec.ts';

const ADDRESS = 'C'.padEnd(56, 'A');
const HASH = 'a'.repeat(64);

const SPEC: SpecJson = {
  schemaVersion: 1,
  wasmHash: HASH,
  sdkVersion: '16.1.0',
  entriesXdr: [],
  functions: [],
  types: [],
  errors: [],
  events: [],
  warnings: [],
};

/** A resolver stand-in that counts calls and records the options it got. */
function fakeResolver(outcome: () => ResolvedContractSpec) {
  const calls: { address: string; opts: GetContractSpecOptions }[] = [];
  const resolve: NonNullable<ContractSpecDeps['resolve']> = async (address, opts) => {
    calls.push({ address, opts });
    return outcome();
  };
  return { resolve, calls };
}

const fromRpc = (): ResolvedContractSpec => ({ spec: SPEC, source: 'rpc', wasmHash: HASH });
const base = { address: ADDRESS, network: 'testnet', wasmHash: HASH };

test('success: returns the spec, its source and hash, and queries the app RPC', async () => {
  const { resolve, calls } = fakeResolver(fromRpc);
  const result = await loadContractSpec(base, {
    resolve,
    appNetwork: 'testnet',
    rpcUrl: 'https://rpc.example',
    allowHttp: false,
  });
  assert.ok(result.ok);
  assert.equal(result.source, 'rpc');
  assert.equal(result.wasmHash, HASH);
  assert.deepEqual(result.spec, SPEC);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.address, ADDRESS);
  assert.equal(calls[0]?.opts.rpcUrl, 'https://rpc.example');
  assert.equal(calls[0]?.opts.network, 'testnet');
  assert.equal(calls[0]?.opts.knownWasmHash, HASH);
});

test('a null wasm hash is not passed as a known hash', async () => {
  const { resolve, calls } = fakeResolver(fromRpc);
  await loadContractSpec({ ...base, wasmHash: null }, { resolve, appNetwork: 'testnet' });
  assert.ok(!('knownWasmHash' in (calls[0]?.opts ?? {})));
});

test('a hash already in the injected cache is served from memory, never refetched', async () => {
  const memory = new LruSpecCache<SpecJson>();
  await memory.set(HASH, SPEC);
  // The real resolver, so the cache chain is the real one. A hit on a known
  // hash makes no RPC call; a miss here would fail against the dead URL.
  const result = await loadContractSpec(base, {
    caches: [memory],
    appNetwork: 'testnet',
    rpcUrl: 'http://127.0.0.1:1',
    allowHttp: true,
  });
  assert.ok(result.ok);
  assert.equal(result.source, 'memory');
});

test('a network mismatch returns wrong_network without any RPC call', async () => {
  const { resolve, calls } = fakeResolver(fromRpc);
  const result = await loadContractSpec(
    { ...base, network: 'mainnet' },
    { resolve, appNetwork: 'testnet' },
  );
  assert.deepEqual(result, {
    ok: false,
    failure: { kind: 'wrong_network', network: 'mainnet', expectedNetwork: 'testnet' },
  });
  assert.equal(calls.length, 0);
});

test('an alias of the app network is not a mismatch; an unknown network is', async () => {
  const { resolve, calls } = fakeResolver(fromRpc);
  const alias = await loadContractSpec(
    { ...base, network: 'Public' },
    { resolve, appNetwork: 'mainnet' },
  );
  assert.ok(alias.ok);
  const unknown = await loadContractSpec(
    { ...base, network: 'staging' },
    { resolve, appNetwork: 'mainnet' },
  );
  assert.deepEqual(unknown, {
    ok: false,
    failure: { kind: 'wrong_network', network: 'staging', expectedNetwork: 'mainnet' },
  });
  assert.equal(calls.length, 1);
});

test('each resolver failure maps to a serialisable failure object', async () => {
  const cases: { thrown: unknown; failure: unknown }[] = [
    {
      thrown: new ContractNotFound(ADDRESS, 'testnet'),
      failure: { kind: 'contract_not_found', network: 'testnet' },
    },
    {
      thrown: new WasmNotFound(HASH, 'testnet'),
      failure: { kind: 'wasm_not_found', network: 'testnet' },
    },
    { thrown: new NoInterface('no_section'), failure: { kind: 'no_interface' } },
    {
      thrown: new InterfaceUnreadable('16.1.0'),
      failure: { kind: 'interface_unreadable', sdkVersion: '16.1.0' },
    },
    { thrown: new RpcUnavailable('https://rpc.example'), failure: { kind: 'unavailable' } },
    { thrown: new Error('boom'), failure: { kind: 'unavailable' } },
    { thrown: 'not even an error', failure: { kind: 'unavailable' } },
  ];
  for (const { thrown, failure } of cases) {
    const result = await loadContractSpec(base, {
      appNetwork: 'testnet',
      resolve: async () => {
        throw thrown;
      },
    });
    assert.deepEqual(result, { ok: false, failure });
    // Plain data: it must round-trip through JSON unchanged.
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  }
});

test('without DATABASE_URL the cache chain is the memory cache alone', () => {
  assert.equal(specCaches(undefined).length, 1);
  assert.equal(specCaches('').length, 1);
});

test('with DATABASE_URL the shared memory cache is first, then the store', () => {
  const chain = specCaches('postgres://example');
  assert.equal(chain.length, 2);
  assert.strictEqual(chain[0], specCaches(undefined)[0]);
});

test('historical wasmHash resolves via code entry without calling getContractWasmByContractId', async () => {
  const repoPackagesDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'packages',
  );
  const wasm = readFileSync(join(repoPackagesDir, 'spec', 'fixtures', 'identity-registry.wasm'));
  const codeEntryJson = JSON.parse(
    readFileSync(join(repoPackagesDir, 'fixtures', 'data', 'contract-wasm-entry.json'), 'utf8'),
  ) as { payload: { entries: { xdr: string }[] } };
  const val = xdr.LedgerEntryData.fromXDR(codeEntryJson.payload.entries[0]!.xdr, 'base64');
  const historicalHash = hash(wasm).toString('hex');
  val.contractCode().hash(Buffer.from(historicalHash, 'hex'));
  val.contractCode().code(wasm);
  const memory = new LruSpecCache<SpecJson>();

  const { getContractSpec } = await import('@signet/spec/resolve');
  let wasmCalls = 0;
  let ledgerCalls = 0;
  const server = {
    async getLedgerEntries(...keys: xdr.LedgerKey[]) {
      ledgerCalls += 1;
      const key = keys[0]!;
      assert.equal(key.switch().name, 'contractCode');
      assert.equal(key.contractCode().hash().toString('hex'), historicalHash);
      return {
        latestLedger: 100,
        entries: [{ key, val, lastModifiedLedgerSeq: 1 }],
      };
    },
    async getContractWasmByContractId(): Promise<Buffer> {
      wasmCalls += 1;
      throw new Error('must not inspect current contract executable for historical hash');
    },
  };

  const result = await loadContractSpec(
    { address: ADDRESS, network: 'testnet', wasmHash: historicalHash },
    {
      appNetwork: 'testnet',
      caches: [memory],
      resolve: (address, opts) => getContractSpec(address, { ...opts, server }),
    },
  );

  assert.ok(result.ok);
  assert.equal(result.wasmHash, historicalHash);
  assert.equal(result.spec.wasmHash, historicalHash);
  assert.equal(wasmCalls, 0);
  assert.equal(ledgerCalls, 1);
  assert.equal(memory.get(historicalHash)?.wasmHash, historicalHash);
});
