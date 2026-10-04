import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, rpc, xdr } from '@stellar/stellar-sdk';
import { loadFixture } from '@signet/fixtures';
import type { Network } from '@signet/types';
import { LruSpecCache } from './cache/lru.ts';
import type { SpecCache } from './cache/types.ts';
import { InterfaceUnreadable, NoInterface, RpcUnavailable } from './errors.ts';
import type { SpecRpcServer } from './fetch.ts';
import type { SpecJson } from './json.ts';
import { getContractSpec } from './resolve.ts';
import type { GetContractSpecOptions, ResolveLogger } from './resolve.ts';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK: Network = 'testnet';
const REGISTRY = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

function fixtureWasm(name: string): Buffer {
  return readFileSync(join(FIXTURES_DIR, `${name}.wasm`));
}

function instanceResponse(
  name: 'registry-instance-entry' | 'sac-instance-entry',
  wasmHash?: string,
): rpc.Api.GetLedgerEntriesResponse {
  const payload = loadFixture(name);
  return {
    latestLedger: payload.latestLedger,
    entries: (payload.entries ?? []).map((entry) => {
      const val = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64');
      if (wasmHash !== undefined) {
        // Re-point the instance at another module, as a contract upgrade does.
        val
          .contractData()
          .val()
          .instance()
          .executable(xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasmHash, 'hex')));
      }
      return {
        key: xdr.LedgerKey.fromXDR(entry.key, 'base64'),
        val,
        lastModifiedLedgerSeq: entry.lastModifiedLedgerSeq,
        liveUntilLedgerSeq: entry.liveUntilLedgerSeq,
      };
    }),
  };
}

/** Counts every RPC call; `wasm` is served for the contract's current code. */
class StubRpcServer implements SpecRpcServer {
  ledgerCalls = 0;
  wasmCalls = 0;
  response: rpc.Api.GetLedgerEntriesResponse = { entries: [], latestLedger: 0 };
  wasm: Buffer | undefined;
  /** Held open until released, so concurrent callers overlap. */
  gate: Promise<void> | undefined;
  ledgerFailure: Error | undefined;

  async getLedgerEntries(): Promise<rpc.Api.GetLedgerEntriesResponse> {
    this.ledgerCalls += 1;
    if (this.ledgerFailure) throw this.ledgerFailure;
    return this.response;
  }

  async getContractWasmByContractId(): Promise<Buffer> {
    this.wasmCalls += 1;
    await this.gate;
    if (!this.wasm) throw new Error('stub: no wasm configured');
    return this.wasm;
  }

  get rpcCalls(): number {
    return this.ledgerCalls + this.wasmCalls;
  }
}

/** Point the stub at a fixture module, with a matching instance hash. */
function deploy(stub: StubRpcServer, name: string): string {
  const wasm = fixtureWasm(name);
  const wasmHash = hash(wasm).toString('hex');
  stub.wasm = wasm;
  stub.response = instanceResponse('registry-instance-entry', wasmHash);
  return wasmHash;
}

class RecordingLogger implements ResolveLogger {
  readonly warnings: { message: string; context?: Record<string, unknown> }[] = [];
  warn(message: string, context?: Record<string, unknown>): void {
    this.warnings.push({ message, context });
  }
}

function options(
  stub: StubRpcServer,
  caches: SpecCache<SpecJson>[],
  extra?: Partial<GetContractSpecOptions>,
): GetContractSpecOptions {
  return { network: NETWORK, rpcUrl: RPC_URL, server: stub, caches, ...extra };
}

test('10 concurrent calls for one uncached hash make exactly one WASM fetch', async () => {
  const stub = new StubRpcServer();
  const wasmHash = deploy(stub, 'identity-registry');
  let release!: () => void;
  stub.gate = new Promise<void>((resolve) => (release = resolve));
  const memory = new LruSpecCache<SpecJson>();

  const calls = Array.from({ length: 10 }, () =>
    getContractSpec(REGISTRY, options(stub, [memory], { knownWasmHash: wasmHash })),
  );
  // Let every caller reach the shared promise before the download completes.
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  const results = await Promise.all(calls);

  assert.equal(stub.wasmCalls, 1);
  assert.ok(results.every((r) => r.source === 'rpc' && r.wasmHash === wasmHash));
  assert.ok(results.every((r) => r.spec === results[0]!.spec));
  assert.equal(memory.get(wasmHash), results[0]!.spec);
});

test('single-flight entry is released after a failure so the next call retries', async () => {
  const stub = new StubRpcServer();
  const wasmHash = deploy(stub, 'identity-registry');
  const good = stub.wasm;
  stub.wasm = undefined;
  const memory = new LruSpecCache<SpecJson>();
  const opts = options(stub, [memory], { knownWasmHash: wasmHash });

  const failures = await Promise.allSettled([
    getContractSpec(REGISTRY, opts),
    getContractSpec(REGISTRY, opts),
  ]);
  assert.ok(failures.every((r) => r.status === 'rejected'));
  assert.equal(stub.wasmCalls, 1);
  assert.equal(memory.size, 0);

  stub.wasm = good;
  const retried = await getContractSpec(REGISTRY, opts);
  assert.equal(retried.source, 'rpc');
  assert.equal(stub.wasmCalls, 2);
});

test('memory hit with knownWasmHash makes zero RPC calls', async () => {
  const stub = new StubRpcServer();
  const wasmHash = deploy(stub, 'identity-registry');
  const memory = new LruSpecCache<SpecJson>();
  const opts = options(stub, [memory], { knownWasmHash: wasmHash });
  const first = await getContractSpec(REGISTRY, opts);
  const callsAfterFirst = stub.rpcCalls;

  const second = await getContractSpec(REGISTRY, opts);

  assert.equal(second.source, 'memory');
  assert.equal(second.spec, first.spec);
  assert.equal(stub.rpcCalls, callsAfterFirst);
});

test('without knownWasmHash the current hash costs one instance read, nothing more', async () => {
  const stub = new StubRpcServer();
  const wasmHash = deploy(stub, 'identity-registry');
  const memory = new LruSpecCache<SpecJson>();
  await getContractSpec(REGISTRY, options(stub, [memory]));
  stub.ledgerCalls = 0;
  stub.wasmCalls = 0;

  const hit = await getContractSpec(REGISTRY, options(stub, [memory]));

  assert.equal(hit.source, 'memory');
  assert.equal(hit.wasmHash, wasmHash);
  assert.equal(stub.ledgerCalls, 1);
  assert.equal(stub.wasmCalls, 0);
});

test('a store hit populates memory and a later call is served from memory', async () => {
  const stub = new StubRpcServer();
  const wasmHash = deploy(stub, 'identity-registry');
  const seed = new LruSpecCache<SpecJson>();
  const { spec } = await getContractSpec(REGISTRY, options(stub, [seed]));
  const memory = new LruSpecCache<SpecJson>();
  const store = new LruSpecCache<SpecJson>();
  store.set(wasmHash, spec);
  stub.wasmCalls = 0;

  const fromStore = await getContractSpec(REGISTRY, options(stub, [memory, store]));
  assert.equal(fromStore.source, 'store');
  assert.equal(memory.get(wasmHash), spec);

  const fromMemory = await getContractSpec(REGISTRY, options(stub, [memory, store]));
  assert.equal(fromMemory.source, 'memory');
  assert.equal(stub.wasmCalls, 0);
});

test('an rpc fetch is written back to every cache', async () => {
  const stub = new StubRpcServer();
  const wasmHash = deploy(stub, 'identity-registry');
  const memory = new LruSpecCache<SpecJson>();
  const store = new LruSpecCache<SpecJson>();

  const { spec, source } = await getContractSpec(REGISTRY, options(stub, [memory, store]));

  assert.equal(source, 'rpc');
  assert.equal(spec.wasmHash, wasmHash);
  assert.equal(memory.get(wasmHash), spec);
  assert.equal(store.get(wasmHash), spec);
});

test('an upgraded contract resolves to the new spec and keeps the old hash cached', async () => {
  const stub = new StubRpcServer();
  const memory = new LruSpecCache<SpecJson>();
  const oldHash = deploy(stub, 'identity-registry');
  const before = await getContractSpec(REGISTRY, options(stub, [memory]));

  const newHash = deploy(stub, 'events');
  const after = await getContractSpec(REGISTRY, options(stub, [memory]));

  assert.notEqual(newHash, oldHash);
  assert.equal(before.wasmHash, oldHash);
  assert.equal(after.wasmHash, newHash);
  assert.equal(after.source, 'rpc');
  assert.notDeepEqual(after.spec.entriesXdr, before.spec.entriesXdr);
  assert.equal(memory.get(oldHash), before.spec);
  assert.equal(memory.get(newHash), after.spec);
});

test('InterfaceUnreadable is logged with hash and SDK version and never cached', async () => {
  const stub = new StubRpcServer();
  const wasmHash = deploy(stub, 'corrupt_section');
  const memory = new LruSpecCache<SpecJson>();
  const logger = new RecordingLogger();

  await assert.rejects(
    getContractSpec(REGISTRY, options(stub, [memory], { logger })),
    (err: unknown) => {
      assert.ok(err instanceof InterfaceUnreadable);
      assert.equal(logger.warnings.length, 1);
      assert.deepEqual(logger.warnings[0]!.context, { wasmHash, sdkVersion: err.sdkVersion });
      return true;
    },
  );
  assert.equal(memory.size, 0);
});

test('a SAC rejects with NoInterface without fetching WASM or touching caches', async () => {
  const stub = new StubRpcServer();
  stub.response = instanceResponse('sac-instance-entry');
  const memory = new LruSpecCache<SpecJson>();

  await assert.rejects(getContractSpec(SAC, options(stub, [memory])), (err: unknown) => {
    assert.ok(err instanceof NoInterface);
    assert.equal(err.reason, 'stellar_asset_contract');
    return true;
  });
  assert.equal(stub.wasmCalls, 0);
  assert.equal(memory.size, 0);
});

test('an unreachable hash lookup surfaces RpcUnavailable', async () => {
  const stub = new StubRpcServer();
  stub.ledgerFailure = new Error('connect ECONNREFUSED');

  await assert.rejects(getContractSpec(REGISTRY, options(stub, [])), RpcUnavailable);
});

test('failing caches are logged and treated as misses, not as failures', async () => {
  const stub = new StubRpcServer();
  const wasmHash = deploy(stub, 'identity-registry');
  const broken: SpecCache<SpecJson> = {
    get() {
      throw new Error('db down');
    },
    set() {
      throw new Error('db down');
    },
  };
  const logger = new RecordingLogger();

  const result = await getContractSpec(
    REGISTRY,
    options(stub, [broken], { knownWasmHash: wasmHash, logger }),
  );

  assert.equal(result.source, 'rpc');
  assert.deepEqual(
    logger.warnings.map((w) => w.message),
    ['spec cache read failed', 'spec cache write failed'],
  );
});
