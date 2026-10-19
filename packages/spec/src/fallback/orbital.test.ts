import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, rpc, xdr } from '@stellar/stellar-sdk';
import { loadFixture } from '@signet/fixtures';
import type { Network } from '@signet/types';
import { LruSpecCache } from '../cache/lru.ts';
import type { SpecCache } from '../cache/types.ts';
import { NoInterface } from '../errors.ts';
import type { SpecRpcServer } from '../fetch.ts';
import type { SpecJson } from '../json.ts';
import { getContractSpec } from '../resolve.ts';
import type { GetContractSpecOptions } from '../resolve.ts';
import { OrbitalFallback, orbitalFallback } from './orbital.ts';
import type { SpecFallback, SpecFallbackResult } from './types.ts';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
const RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK: Network = 'testnet';
const REGISTRY = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';

function fixtureWasm(name: string): Buffer {
  return readFileSync(join(FIXTURES_DIR, `${name}.wasm`));
}

function instanceResponse(wasmHash?: string): rpc.Api.GetLedgerEntriesResponse {
  const payload = loadFixture('registry-instance-entry');
  return {
    latestLedger: payload.latestLedger,
    entries: (payload.entries ?? []).map((entry) => {
      const val = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64');
      if (wasmHash !== undefined) {
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

class StubRpcServer implements SpecRpcServer {
  ledgerCalls = 0;
  wasmCalls = 0;
  response: rpc.Api.GetLedgerEntriesResponse = { entries: [], latestLedger: 0 };
  wasm: Buffer | undefined;

  async getLedgerEntries(): Promise<rpc.Api.GetLedgerEntriesResponse> {
    this.ledgerCalls += 1;
    return this.response;
  }

  async getContractWasmByContractId(): Promise<Buffer> {
    this.wasmCalls += 1;
    if (!this.wasm) throw new Error('stub: no wasm configured');
    return this.wasm;
  }
}

function deploy(stub: StubRpcServer, name: string): string {
  const wasm = fixtureWasm(name);
  const wasmHash = hash(wasm).toString('hex');
  stub.wasm = wasm;
  stub.response = instanceResponse(wasmHash);
  return wasmHash;
}

function options(
  stub: StubRpcServer,
  caches: SpecCache<SpecJson>[],
  extra?: Partial<GetContractSpecOptions>,
): GetContractSpecOptions {
  return { network: NETWORK, rpcUrl: RPC_URL, server: stub, caches, ...extra };
}

test('OrbitalFallback: resolves spec from registry HTTP response', async () => {
  const fallback = new OrbitalFallback();
  const testHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  const stubFetch = (async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        attestationPointer: 'orbital://attestations/12345',
        attestationHash: 'deadbeef1234567890',
        spec: {
          functions: [
            {
              name: 'swap',
              inputs: [],
              outputs: ['void'],
              doc: '',
              isConstructor: false,
            },
          ],
          types: [],
          errors: [],
          events: [],
          warnings: [],
        },
      }),
    } as unknown as Response;
  }) as typeof fetch;

  const result = await fallback.resolve(REGISTRY, testHash, {
    fetch: stubFetch,
  });

  assert.ok(result);
  assert.equal(result.provenance, 'orbital_registry');
  assert.equal(result.attestationPointer, 'orbital://attestations/12345');
  assert.equal(result.attestationHash, 'deadbeef1234567890');
  assert.equal(result.spec.provenance, 'orbital_registry');
  assert.equal(result.spec.functions.length, 1);
  assert.equal(result.spec.functions[0]?.name, 'swap');
});

test('OrbitalFallback: returns undefined when registry returns 404', async () => {
  const fallback = new OrbitalFallback();
  const testHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  const stubFetch = (async () => {
    return {
      ok: false,
      status: 404,
    } as unknown as Response;
  }) as typeof fetch;

  const result = await fallback.resolve(REGISTRY, testHash, {
    fetch: stubFetch,
  });

  assert.equal(result, undefined);
});

test('fallback integration: embedded spec present means fallback is never called', async () => {
  const stub = new StubRpcServer();
  deploy(stub, 'identity-registry');

  let fallbackCalled = false;
  const stubFallback: SpecFallback = {
    name: 'mock_orbital',
    async resolve() {
      fallbackCalled = true;
      return null;
    },
  };

  const memory = new LruSpecCache<SpecJson>();
  const opts = options(stub, [memory], { fallback: stubFallback });

  const result = await getContractSpec(REGISTRY, opts);
  assert.equal(fallbackCalled, false, 'fallback should never be called when embedded spec is present');
  assert.equal(result.provenance, 'embedded');
  assert.equal(result.spec.provenance, 'embedded');
  assert.equal(result.spec.functions.length, 8);
});

test('fallback integration: no section plus a registry hit returns provenance orbital_registry', async () => {
  const stub = new StubRpcServer();
  const wasmHash = deploy(stub, 'no_spec');

  let fallbackCalled = false;
  const stubFallback: SpecFallback = {
    name: 'mock_orbital',
    async resolve(_addr, h) {
      fallbackCalled = true;
      return {
        provenance: 'orbital_registry',
        attestationPointer: `orbital://attestations/${h}`,
        attestationHash: 'hash-abc-123',
        spec: {
          schemaVersion: 1,
          wasmHash: h,
          sdkVersion: '16.1.0',
          entriesXdr: [],
          functions: [
            {
              name: 'external_fn',
              inputs: [],
              outputs: ['void'],
              doc: '',
              isConstructor: false,
            },
          ],
          types: [],
          errors: [],
          events: [],
          warnings: ['attestation from orbital'],
        },
      };
    },
  };

  const memory = new LruSpecCache<SpecJson>();
  const opts = options(stub, [memory], { fallback: stubFallback });

  const result = await getContractSpec(REGISTRY, opts);
  assert.equal(fallbackCalled, true);
  assert.equal(result.provenance, 'orbital_registry');
  assert.equal(result.attestationPointer, `orbital://attestations/${wasmHash}`);
  assert.equal(result.attestationHash, 'hash-abc-123');
  assert.equal(result.spec.provenance, 'orbital_registry');
  assert.equal(result.spec.functions[0]?.name, 'external_fn');
});

test('fallback integration: no section plus a registry miss still gives NoInterface', async () => {
  const stub = new StubRpcServer();
  deploy(stub, 'no_spec');

  let fallbackCalled = false;
  const stubFallback: SpecFallback = {
    name: 'mock_orbital',
    async resolve() {
      fallbackCalled = true;
      return undefined; // miss
    },
  };

  const memory = new LruSpecCache<SpecJson>();
  const opts = options(stub, [memory], { fallback: stubFallback });

  await assert.rejects(
    getContractSpec(REGISTRY, opts),
    (err: unknown) => {
      assert.ok(err instanceof NoInterface);
      assert.equal((err as NoInterface).reason, 'no_section');
      return true;
    },
  );
  assert.equal(fallbackCalled, true);
});

test('fallback integration: disabled unless SIGNET_SPEC_ORBITAL_FALLBACK=1', async () => {
  const stub = new StubRpcServer();
  deploy(stub, 'no_spec');

  delete process.env.SIGNET_SPEC_ORBITAL_FALLBACK;

  const memory = new LruSpecCache<SpecJson>();
  const opts = options(stub, [memory]);

  await assert.rejects(
    getContractSpec(REGISTRY, opts),
    (err: unknown) => {
      assert.ok(err instanceof NoInterface);
      assert.equal((err as NoInterface).reason, 'no_section');
      return true;
    },
  );
});
