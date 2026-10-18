import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc, xdr } from '@stellar/stellar-sdk';
import { loadFixture, loadFixtureEnvelope } from '@signet/fixtures';
import type { Network } from '@signet/types';
import { ContractNotFound, InvalidWasm, NoInterface, RpcUnavailable } from './errors.ts';
import { fetchContractSpec, fetchWasmHash, maxRpcResponseBytes } from './fetch.ts';
import type { FetchOptions, SpecRpcServer } from './fetch.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SPEC_FIXTURES_DIR = join(__dirname, '..', 'fixtures');

const RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK: Network = 'testnet';
const REGISTRY = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const REGISTRY_WASM_HASH = '936996c74b7d383c56ec174857b15927cdd29478c6909da332b4dec8b67335fe';

class StubRpcServer implements SpecRpcServer {
  readonly ledgerKeys: xdr.LedgerKey[] = [];
  ledgerCalls = 0;
  wasmCalls = 0;
  hang = false;
  ledgerFailure: unknown;
  response: rpc.Api.GetLedgerEntriesResponse = { entries: [], latestLedger: 0 };
  wasm: Buffer | undefined;

  async getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<rpc.Api.GetLedgerEntriesResponse> {
    this.ledgerCalls += 1;
    this.ledgerKeys.push(...keys);
    if (this.hang) {
      return new Promise(() => {});
    }
    if (this.ledgerFailure !== undefined) {
      throw this.ledgerFailure;
    }
    return this.response;
  }

  async getContractWasmByContractId(): Promise<Buffer> {
    this.wasmCalls += 1;
    if (!this.wasm) {
      throw new Error('stub: no wasm configured');
    }
    return this.wasm;
  }
}

function parsedInstanceResponse(
  name: 'registry-instance-entry' | 'sac-instance-entry',
): rpc.Api.GetLedgerEntriesResponse {
  const payload = loadFixture(name);
  return {
    latestLedger: payload.latestLedger,
    entries: (payload.entries ?? []).map((entry) => ({
      key: xdr.LedgerKey.fromXDR(entry.key, 'base64'),
      val: xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64'),
      lastModifiedLedgerSeq: entry.lastModifiedLedgerSeq,
      liveUntilLedgerSeq: entry.liveUntilLedgerSeq,
    })),
  };
}

function recordedRegistryWasm(): Buffer {
  const payload = loadFixture('contract-wasm-entry');
  const entry = payload.entries?.[0];
  assert.ok(entry, 'contract-wasm-entry recording has an entry');
  return xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64').contractCode().code();
}

function registryStub(): StubRpcServer {
  const stub = new StubRpcServer();
  stub.response = parsedInstanceResponse('registry-instance-entry');
  stub.wasm = recordedRegistryWasm();
  return stub;
}

function stubOptions(stub: StubRpcServer, extra?: Partial<FetchOptions>): FetchOptions {
  return { network: NETWORK, rpcUrl: RPC_URL, server: stub, ...extra };
}

test('fetchContractSpec: registry recording decodes to 9 spec entries', async () => {
  const stub = registryStub();

  const spec = await fetchContractSpec(REGISTRY, stubOptions(stub));

  assert.equal(spec.entries.length, 9);
  assert.equal(spec.wasmHash, REGISTRY_WASM_HASH);
  assert.equal(stub.wasmCalls, 1);

  const envelope = loadFixtureEnvelope('registry-instance-entry');
  const recordedKey = (envelope.request.params as { keys: string[] }).keys[0];
  assert.equal(stub.ledgerKeys[0]?.toXDR('base64'), recordedKey);
});

test('fetchWasmHash: registry instance yields its WASM hash', async () => {
  const stub = registryStub();

  const result = await fetchWasmHash(REGISTRY, stubOptions(stub));

  assert.deepEqual(result, { type: 'wasm', wasmHash: REGISTRY_WASM_HASH });
  assert.equal(stub.ledgerCalls, 1);
  assert.equal(stub.wasmCalls, 0);
});

// The recorded registry entry is live: its TTL is ahead of the recorded ledger.
function registryTtl(stub: StubRpcServer): number {
  const ttl = stub.response.entries[0]?.liveUntilLedgerSeq;
  assert.ok(ttl !== undefined, 'the recording carries a TTL');
  return ttl;
}

test('fetchWasmHash: a live instance carries no archived flag at all', async () => {
  const result = await fetchWasmHash(REGISTRY, stubOptions(registryStub()));
  assert.equal('archived' in result, false);
});

test('fetchWasmHash: an instance whose TTL has passed is flagged archived, hash intact', async () => {
  const stub = registryStub();
  stub.response = { ...stub.response, latestLedger: registryTtl(stub) + 1 };

  const result = await fetchWasmHash(REGISTRY, stubOptions(stub));

  assert.deepEqual(result, { type: 'wasm', wasmHash: REGISTRY_WASM_HASH, archived: true });
});

test('fetchWasmHash: live through the TTL ledger itself, expired the ledger after', async () => {
  const stub = registryStub();
  const ttl = registryTtl(stub);

  stub.response = { ...stub.response, latestLedger: ttl };
  assert.equal('archived' in (await fetchWasmHash(REGISTRY, stubOptions(stub))), false);

  stub.response = { ...stub.response, latestLedger: ttl + 1 };
  assert.equal((await fetchWasmHash(REGISTRY, stubOptions(stub))).archived, true);
});

test('fetchWasmHash: an entry with no TTL in the response is not called archived', async () => {
  const stub = registryStub();
  const [entry] = stub.response.entries;
  assert.ok(entry);
  stub.response = {
    latestLedger: Number.MAX_SAFE_INTEGER,
    entries: [{ key: entry.key, val: entry.val }],
  };

  const result = await fetchWasmHash(REGISTRY, stubOptions(stub));

  assert.deepEqual(result, { type: 'wasm', wasmHash: REGISTRY_WASM_HASH });
});

test('missing instance entry: ContractNotFound carries the network', async () => {
  const stub = new StubRpcServer();
  stub.response = { entries: [], latestLedger: 4887004 };

  await assert.rejects(fetchWasmHash(REGISTRY, stubOptions(stub)), (err: unknown) => {
    assert.ok(err instanceof ContractNotFound);
    assert.equal(err.kind, 'contract_not_found');
    assert.equal(err.address, REGISTRY);
    assert.equal(err.network, 'testnet');
    assert.match(err.message, /testnet/);
    return true;
  });
});

test('transport failure: ECONNREFUSED becomes RpcUnavailable', async () => {
  const stub = new StubRpcServer();
  const refused = new Error('connect ECONNREFUSED 127.0.0.1:8080');
  stub.ledgerFailure = refused;

  await assert.rejects(fetchWasmHash(REGISTRY, stubOptions(stub)), (err: unknown) => {
    assert.ok(err instanceof RpcUnavailable);
    assert.equal(err.kind, 'rpc_unavailable');
    assert.equal(err.rpcUrl, RPC_URL);
    assert.equal(err.cause, refused);
    return true;
  });
});

test('SAC instance: NoInterface{stellar_asset_contract} with zero WASM fetches', async () => {
  const stub = new StubRpcServer();
  stub.response = parsedInstanceResponse('sac-instance-entry');
  stub.wasm = recordedRegistryWasm();

  await assert.rejects(fetchContractSpec(SAC, stubOptions(stub)), (err: unknown) => {
    assert.ok(err instanceof NoInterface);
    assert.equal(err.kind, 'no_interface');
    assert.equal(err.reason, 'stellar_asset_contract');
    return true;
  });
  assert.equal(stub.wasmCalls, 0);

  const result = await fetchWasmHash(SAC, stubOptions(stub));
  assert.deepEqual(result, { type: 'stellar_asset' });
});

test('invalid contract address is rejected before any RPC call', async () => {
  const stub = new StubRpcServer();

  await assert.rejects(fetchWasmHash('CNOTAVALIDCONTRACT', stubOptions(stub)), TypeError);
  assert.equal(stub.ledgerCalls, 0);
});

test('an aborted signal rejects with RpcUnavailable before the default deadline', async () => {
  const stub = registryStub();
  stub.hang = true;

  // A ref'd timer, not `AbortSignal.timeout(50)`: that one is unref'd, so on
  // Node 22 (CI) nothing keeps the loop alive while the stub hangs and the
  // runner cancels the test as "event loop has already resolved".
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('test deadline')), 50);

  await assert.rejects(
    fetchWasmHash(REGISTRY, stubOptions(stub, { signal: controller.signal })).finally(() =>
      clearTimeout(timer),
    ),
    (err: unknown) => {
      assert.ok(err instanceof RpcUnavailable);
      assert.equal(err.rpcUrl, RPC_URL);
      return true;
    },
  );
  assert.equal(stub.ledgerCalls, 1);
});

test('WASM hash mismatch between instance and fetched module: RpcUnavailable', async () => {
  const stub = registryStub();
  stub.wasm = readFileSync(join(SPEC_FIXTURES_DIR, 'types_zoo.wasm'));

  await assert.rejects(fetchContractSpec(REGISTRY, stubOptions(stub)), (err: unknown) => {
    assert.ok(err instanceof RpcUnavailable);
    assert.match(String((err.cause as Error).message), /does not match instance hash/);
    return true;
  });
});

test('fetchContractSpec aborts a streaming RPC response early when bytes exceed the size cap', async () => {
  const instancePayload = loadFixture('registry-instance-entry');
  const maxWasmBytes = 32 * 1024;
  const maxResponseBytes = maxRpcResponseBytes(maxWasmBytes);
  const totalStreamAttempt = 2 * 1024 * 1024; // 2 MB stream
  const chunkSize = 8 * 1024;
  let streamedBytes = 0;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id: number;
        params?: { keys?: string[] };
      };
      const keyB64 = body.params?.keys?.[0] ?? '';
      const key = xdr.LedgerKey.fromXDR(keyB64, 'base64');

      if (key.switch().name === 'contractData') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: instancePayload }));
        return;
      }

      // contractCode request: stream chunked bytes via setImmediate until cancelled
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      const chunk = Buffer.alloc(chunkSize, 0x61);
      const pump = () => {
        if (res.destroyed || res.writableEnded || streamedBytes >= totalStreamAttempt) {
          if (!res.destroyed && !res.writableEnded) res.end();
          return;
        }
        streamedBytes += chunk.byteLength;
        res.write(chunk, () => {
          setImmediate(pump);
        });
      };
      pump();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const rpcUrl = `http://127.0.0.1:${port}`;

  try {
    await assert.rejects(
      fetchContractSpec(REGISTRY, {
        network: 'testnet',
        rpcUrl,
        allowHttp: true,
        maxWasmBytes,
      }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidWasm, `expected InvalidWasm, got ${String(err)}`);
        return true;
      },
    );

    assert.ok(
      streamedBytes > maxResponseBytes && streamedBytes < totalStreamAttempt / 2,
      `expected stream to abort shortly after ${maxResponseBytes} bytes, but consumed ${streamedBytes} of ${totalStreamAttempt} bytes`,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('fetchContractSpec refuses an oversized Content-Length before reading the body', async () => {
  const instancePayload = loadFixture('registry-instance-entry');
  const maxWasmBytes = 32 * 1024;
  let codeBodyBytesWritten = 0;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id: number;
        params?: { keys?: string[] };
      };
      const keyB64 = body.params?.keys?.[0] ?? '';
      const key = xdr.LedgerKey.fromXDR(keyB64, 'base64');

      if (key.switch().name === 'contractData') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: instancePayload }));
        return;
      }

      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(10 * 1024 * 1024),
      });
      res.flushHeaders();
      const timer = setTimeout(() => {
        if (!res.destroyed && !res.writableEnded) {
          codeBodyBytesWritten += 65_536;
          res.write(Buffer.alloc(65_536, 0x61));
        }
      }, 200);
      req.on('close', () => clearTimeout(timer));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const rpcUrl = `http://127.0.0.1:${port}`;

  try {
    await assert.rejects(
      fetchContractSpec(REGISTRY, {
        network: 'testnet',
        rpcUrl,
        allowHttp: true,
        maxWasmBytes,
      }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidWasm, `expected InvalidWasm, got ${String(err)}`);
        return true;
      },
    );
    assert.equal(codeBodyBytesWritten, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test(
  'live: fetches the identity-registry spec from public testnet',
  { skip: process.env.SIGNET_SPEC_LIVE !== '1' },
  async () => {
    const spec = await fetchContractSpec(REGISTRY, { network: 'testnet', rpcUrl: RPC_URL });

    assert.equal(spec.entries.length, 9);
    assert.equal(spec.wasmHash, REGISTRY_WASM_HASH);
  },
);
