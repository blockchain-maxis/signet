import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveInstanceLoader } from './contract-header-source.ts';
import { contractTag, createMemoryDataCache } from './contract-cache.ts';

const ADDRESS = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const HASH_A = 'aa'.repeat(32);
const HASH_B = 'bb'.repeat(32);

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (seconds: number) => void (t += seconds * 1000) };
}

type Answer =
  | { type: 'wasm'; wasmHash: string; archived?: true }
  | { type: 'stellar_asset' }
  | Error;

/** A stand-in for `fetchWasmHash` that counts reads and answers from a variable. */
function rpc(initial: Answer) {
  const stub = {
    reads: 0,
    answer: initial,
    fetchWasmHash: async () => {
      stub.reads += 1;
      if (stub.answer instanceof Error) throw stub.answer;
      return stub.answer;
    },
  };
  return stub;
}

function setup(initial: Answer) {
  const c = clock();
  const stub = rpc(initial);
  const dataCache = createMemoryDataCache(c.now);
  const load = createLiveInstanceLoader({ fetchWasmHash: stub.fetchWasmHash, dataCache });
  return { c, stub, dataCache, load };
}

test('two renders within a minute make one RPC instance read', async () => {
  const { c, stub, load } = setup({ type: 'wasm', wasmHash: HASH_A });

  assert.equal((await load(ADDRESS, 'testnet')).wasmHash, HASH_A);
  c.advance(59);
  assert.equal((await load(ADDRESS, 'testnet')).wasmHash, HASH_A);

  assert.equal(stub.reads, 1);
});

test('after a minute the instance is read again, and an upgrade shows', async () => {
  const { c, stub, load } = setup({ type: 'wasm', wasmHash: HASH_A });

  assert.equal((await load(ADDRESS, 'testnet')).wasmHash, HASH_A);
  stub.answer = { type: 'wasm', wasmHash: HASH_B }; // the contract was upgraded
  c.advance(59);
  assert.equal((await load(ADDRESS, 'testnet')).wasmHash, HASH_A, 'still the remembered hash');

  c.advance(1); // 60 s
  assert.equal((await load(ADDRESS, 'testnet')).wasmHash, HASH_B);
  assert.equal(stub.reads, 2);
});

test('a failed read is null and is not remembered: the next render tries again', async () => {
  const { stub, load } = setup(new Error('ECONNREFUSED'));

  assert.equal((await load(ADDRESS, 'testnet')).wasmHash, null);
  assert.equal(stub.reads, 1);

  stub.answer = { type: 'wasm', wasmHash: HASH_A }; // the RPC recovers
  assert.equal((await load(ADDRESS, 'testnet')).wasmHash, HASH_A, 'no stale failure served');
  assert.equal(stub.reads, 2);
});

test('a Stellar Asset Contract has no WASM: that is an answer, so it is remembered', async () => {
  const { stub, load } = setup({ type: 'stellar_asset' });

  assert.equal((await load(ADDRESS, 'testnet')).wasmHash, null);
  assert.equal((await load(ADDRESS, 'testnet')).wasmHash, null);

  assert.equal(stub.reads, 1);
});

test('the same address on another network is a separate read', async () => {
  const { stub, load } = setup({ type: 'wasm', wasmHash: HASH_A });

  await load(ADDRESS, 'testnet');
  await load(ADDRESS, 'mainnet');

  assert.equal(stub.reads, 2);
});

test('the entry carries the contract tag, so clearing the contract clears the read', async () => {
  const { stub, dataCache, load } = setup({ type: 'wasm', wasmHash: HASH_A });

  await load(ADDRESS, 'testnet');
  dataCache.clear(contractTag(ADDRESS));
  await load(ADDRESS, 'testnet');

  assert.equal(stub.reads, 2);
});

test('the read gets the network, the endpoint and a deadline', async () => {
  const c = clock();
  const seen: Array<{ network: string; rpcUrl: string; hasSignal: boolean }> = [];
  const load = createLiveInstanceLoader({
    dataCache: createMemoryDataCache(c.now),
    fetchWasmHash: async (_address, opts) => {
      seen.push({ network: opts.network, rpcUrl: opts.rpcUrl, hasSignal: opts.signal !== undefined });
      return { type: 'wasm', wasmHash: HASH_A };
    },
  });

  await load(ADDRESS, 'testnet');

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.network, 'testnet');
  assert.ok(seen[0]?.rpcUrl.length);
  assert.equal(seen[0]?.hasSignal, true);
});

test('an expired instance reads as archived, and is remembered like any answer', async () => {
  const { stub, load } = setup({ type: 'wasm', wasmHash: HASH_A, archived: true });

  assert.deepEqual(await load(ADDRESS, 'testnet'), { wasmHash: HASH_A, archived: true });
  assert.deepEqual(await load(ADDRESS, 'testnet'), { wasmHash: HASH_A, archived: true });
  assert.equal(stub.reads, 1);
});

test('a failed read is unread, not archived', async () => {
  const { load } = setup(new Error('ECONNREFUSED'));
  assert.deepEqual(await load(ADDRESS, 'testnet'), { wasmHash: null, archived: false });
});
