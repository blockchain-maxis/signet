import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContractSpec, toSpecJson, type SpecJson } from '@signet/spec';
import {
  buildStubReadme,
  createZipArchive,
  handleContractStubGo,
  handleContractStubTs,
  readZipEntries,
  type ContractStubDeps,
} from './contract-stub.ts';

const wasmPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/spec/fixtures/identity-registry.wasm',
);
const wasmBytes = fs.readFileSync(wasmPath);
const registrySpecJson = toSpecJson(parseContractSpec(wasmBytes));

const TEST_HANDLE = 'alice';
const TEST_ADDRESS = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const TEST_NETWORK = 'testnet';
const TEST_WASM_HASH = registrySpecJson.wasmHash;

function mockDeps(overrides: Partial<ContractStubDeps> = {}): ContractStubDeps {
  return {
    attribute: async (handle, address) => {
      if (handle === TEST_HANDLE && address === TEST_ADDRESS) {
        return {
          status: 'attributed',
          source: 'database',
          contract: {
            address: TEST_ADDRESS,
            network: TEST_NETWORK,
            deployerPubkey: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
            deployTxHash: 'abc123def456',
            deployedAt: '2026-09-27T11:42:01.000Z',
            wasmHash: TEST_WASM_HASH,
          },
        };
      }
      return { status: 'not-attributed' };
    },
    loadSpec: async () => ({
      ok: true,
      spec: registrySpecJson,
      source: 'rpc',
      wasmHash: TEST_WASM_HASH,
    }),
    rateLimiter: async () => null,
    ...overrides,
  };
}

test('createZipArchive and readZipEntries round trip file contents and paths', () => {
  const files = [
    { path: 'README.md', content: '# Hello World\n' },
    { path: 'src/client.ts', content: 'export class Client {}\n' },
    { path: 'package.json', content: '{"name":"test"}' },
  ];
  const zip = createZipArchive(files);
  assert.ok(zip.length > 0);

  const extracted = readZipEntries(zip);
  assert.equal(extracted.size, 3);
  assert.equal(extracted.get('README.md'), '# Hello World\n');
  assert.equal(extracted.get('src/client.ts'), 'export class Client {}\n');
  assert.equal(extracted.get('package.json'), '{"name":"test"}');
});

test('buildStubReadme prepends contract address, network, WASM hash, date, version, and upgrade warning', () => {
  const readme = buildStubReadme({
    contractName: 'identity-registry',
    contractAddress: TEST_ADDRESS,
    network: TEST_NETWORK,
    wasmHash: TEST_WASM_HASH,
    generatorVersion: '16.1.0',
    generatedAt: '2026-10-16T12:00:00.000Z',
    baseReadme: '# Original Readme',
  });

  assert.ok(readme.includes('# identity-registry Client Stub'));
  assert.ok(readme.includes(`- **Contract Address:** \`${TEST_ADDRESS}\``));
  assert.ok(readme.includes(`- **Network:** \`${TEST_NETWORK}\``));
  assert.ok(readme.includes(`- **WASM Hash:** \`${TEST_WASM_HASH}\``));
  assert.ok(readme.includes('- **Generated At:** `2026-10-16T12:00:00.000Z`'));
  assert.ok(readme.includes('- **Generator Version:** `@stellar/stellar-sdk@16.1.0`'));
  assert.ok(readme.includes('This client stub is generated from and tied to WASM hash'));
  assert.ok(readme.includes('must be regenerated to reflect any interface changes'));
  assert.ok(readme.includes('# Original Readme'));
});

test('handleContractStubTs: 200 application/zip with registry fixture and client.ts declaring claim method', async () => {
  const req = new Request(
    `https://signet.local/p/${TEST_HANDLE}/contract/${TEST_ADDRESS}/stub/ts?name=identity-registry`,
    { method: 'GET' },
  );

  const res = await handleContractStubTs(
    req,
    { handle: TEST_HANDLE, address: TEST_ADDRESS },
    mockDeps(),
  );

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.equal(
    res.headers.get('content-disposition'),
    'attachment; filename="identity-registry-client.zip"',
  );
  assert.ok(res.headers.get('etag')?.includes(TEST_WASM_HASH));
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');

  const arrayBuffer = await res.arrayBuffer();
  const zipBytes = new Uint8Array(arrayBuffer);
  const entries = readZipEntries(zipBytes);

  assert.ok(entries.has('src/client.ts'));
  assert.ok(entries.has('src/index.ts'));
  assert.ok(entries.has('package.json'));
  assert.ok(entries.has('tsconfig.json'));
  assert.ok(entries.has('README.md'));
  assert.ok(entries.has('.gitignore'));

  const clientSource = entries.get('src/client.ts')!;
  assert.ok(clientSource.includes('export class Client'));
  assert.ok(clientSource.includes('claim('));

  const readmeSource = entries.get('README.md')!;
  assert.ok(readmeSource.includes(TEST_ADDRESS));
  assert.ok(readmeSource.includes(TEST_WASM_HASH));
  assert.ok(readmeSource.includes('must be regenerated'));
});

test('handleContractStubTs: caches by WASM hash ETag and returns 304 on If-None-Match', async () => {
  const deps = mockDeps();
  const etag = `"${TEST_WASM_HASH}-16.1.0"`;

  const req = new Request(
    `https://signet.local/p/${TEST_HANDLE}/contract/${TEST_ADDRESS}/stub/ts`,
    {
      method: 'GET',
      headers: { 'if-none-match': etag },
    },
  );

  const res = await handleContractStubTs(
    req,
    { handle: TEST_HANDLE, address: TEST_ADDRESS },
    deps,
  );

  assert.equal(res.status, 304);
  assert.equal(res.headers.get('etag'), etag);
  const text = await res.text();
  assert.equal(text, '');
});

test('handleContractStubTs: returns 404 with JSON reason when spec has no_interface', async () => {
  const deps = mockDeps({
    loadSpec: async () => ({
      ok: false,
      failure: { kind: 'no_interface' },
    }),
  });

  const req = new Request(
    `https://signet.local/p/${TEST_HANDLE}/contract/${TEST_ADDRESS}/stub/ts`,
    { method: 'GET' },
  );

  const res = await handleContractStubTs(
    req,
    { handle: TEST_HANDLE, address: TEST_ADDRESS },
    deps,
  );

  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string; reason: string };
  assert.equal(body.reason, 'no_interface');
});

test('handleContractStubTs: returns 404 with JSON reason when spec entries are empty', async () => {
  const emptySpec: SpecJson = {
    schemaVersion: 1,
    wasmHash: TEST_WASM_HASH,
    sdkVersion: '16.1.0',
    entriesXdr: [],
    functions: [],
    types: [],
    errors: [],
    events: [],
    warnings: [],
  };

  const deps = mockDeps({
    loadSpec: async () => ({
      ok: true,
      spec: emptySpec,
      source: 'rpc',
      wasmHash: TEST_WASM_HASH,
    }),
  });

  const req = new Request(
    `https://signet.local/p/${TEST_HANDLE}/contract/${TEST_ADDRESS}/stub/ts`,
    { method: 'GET' },
  );

  const res = await handleContractStubTs(
    req,
    { handle: TEST_HANDLE, address: TEST_ADDRESS },
    deps,
  );

  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string; reason: string };
  assert.equal(body.reason, 'no_interface');
});

test('handleContractStubTs: returns 404 with JSON reason for non-attributed contracts', async () => {
  const deps = mockDeps({
    attribute: async () => ({ status: 'not-attributed' }),
  });

  const req = new Request(
    `https://signet.local/p/${TEST_HANDLE}/contract/${TEST_ADDRESS}/stub/ts`,
    { method: 'GET' },
  );

  const res = await handleContractStubTs(
    req,
    { handle: TEST_HANDLE, address: TEST_ADDRESS },
    deps,
  );

  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string; reason: string };
  assert.equal(body.reason, 'not_attributed');
});

test('handleContractStubTs: returns 503 when attribution lookup is unavailable', async () => {
  const deps = mockDeps({
    attribute: async () => ({ status: 'unavailable' }),
  });

  const req = new Request(
    `https://signet.local/p/${TEST_HANDLE}/contract/${TEST_ADDRESS}/stub/ts`,
    { method: 'GET' },
  );

  const res = await handleContractStubTs(
    req,
    { handle: TEST_HANDLE, address: TEST_ADDRESS },
    deps,
  );

  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: string; reason: string };
  assert.equal(body.reason, 'attribution_unavailable');
});

test('handleContractStubTs: returns 429 when rate-limited with Retry-After header', async () => {
  const deps = mockDeps({
    rateLimiter: async () => ({ retryAfter: 25 }),
  });

  const req = new Request(
    `https://signet.local/p/${TEST_HANDLE}/contract/${TEST_ADDRESS}/stub/ts`,
    { method: 'GET' },
  );

  const res = await handleContractStubTs(
    req,
    { handle: TEST_HANDLE, address: TEST_ADDRESS },
    deps,
  );

  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '25');
  const body = (await res.json()) as { error: string; code: string };
  assert.equal(body.code, 'rate-limited');
});

test('handleContractStubTs: returns 405 Method Not Allowed on mutating requests', async () => {
  const req = new Request(
    `https://signet.local/p/${TEST_HANDLE}/contract/${TEST_ADDRESS}/stub/ts`,
    { method: 'POST' },
  );

  const res = await handleContractStubTs(
    req,
    { handle: TEST_HANDLE, address: TEST_ADDRESS },
    mockDeps(),
  );

  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET, HEAD');
});

test('handleContractStubTs: returns 200 with null body on HEAD requests', async () => {
  const req = new Request(
    `https://signet.local/p/${TEST_HANDLE}/contract/${TEST_ADDRESS}/stub/ts`,
    { method: 'HEAD' },
  );

  const res = await handleContractStubTs(
    req,
    { handle: TEST_HANDLE, address: TEST_ADDRESS },
    mockDeps(),
  );

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const text = await res.text();
  assert.equal(text, '');
});

// ─── Go stub (#480) ───────────────────────────────────────────────────────────

const goUrl = `https://signet.local/p/${TEST_HANDLE}/contract/${TEST_ADDRESS}/stub/go`;

test('handleContractStubGo: 200 with one .go file for the registry fixture', async () => {
  const res = await handleContractStubGo(
    new Request(`${goUrl}?contractName=registry`),
    { handle: TEST_HANDLE, address: TEST_ADDRESS },
    mockDeps(),
  );

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/x-go; charset=utf-8');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="registry-client.go"');
  assert.match(res.headers.get('etag') ?? '', new RegExp(`^"go-${TEST_WASM_HASH}-`));
  const body = await res.text();
  assert.match(body, /^\/\/ Package registry is a THIN client stub/);
  assert.ok(body.includes(`const ContractID = "${TEST_ADDRESS}"`));
});

test('handleContractStubGo: 304 on a matching If-None-Match', async () => {
  const first = await handleContractStubGo(
    new Request(goUrl),
    { handle: TEST_HANDLE, address: TEST_ADDRESS },
    mockDeps(),
  );
  const etag = first.headers.get('etag')!;

  const res = await handleContractStubGo(
    new Request(goUrl, { headers: { 'if-none-match': etag } }),
    { handle: TEST_HANDLE, address: TEST_ADDRESS },
    mockDeps(),
  );
  assert.equal(res.status, 304);
  assert.equal(await res.text(), '');
});

test('handleContractStubGo: uses its own rate-limit bucket', async () => {
  const buckets: string[] = [];
  const res = await handleContractStubGo(
    new Request(goUrl),
    { handle: TEST_HANDLE, address: TEST_ADDRESS },
    mockDeps({
      rateLimiter: async (_headers, bucket) => {
        buckets.push(bucket);
        return { retryAfter: 30 } as never;
      },
    }),
  );
  assert.deepEqual(buckets, ['stubGo']);
  assert.equal(res.status, 429);
});

test('handleContractStubGo: 404 for a contract not attributed to the handle', async () => {
  const res = await handleContractStubGo(
    new Request(`https://signet.local/p/bob/contract/${TEST_ADDRESS}/stub/go`),
    { handle: 'bob', address: TEST_ADDRESS },
    mockDeps(),
  );
  assert.equal(res.status, 404);
});

test('handleContractStubGo: HEAD answers 200 with no body', async () => {
  const res = await handleContractStubGo(
    new Request(goUrl, { method: 'HEAD' }),
    { handle: TEST_HANDLE, address: TEST_ADDRESS },
    mockDeps(),
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
});
