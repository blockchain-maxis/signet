import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProvenanceModel, formatExtractedAt } from './contract-provenance.ts';
import { stellarExpertContractUrl } from './network.ts';

const ADDRESS = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const HASH = 'ab'.repeat(32);
const base = { address: ADDRESS, network: 'testnet', indexedWasmHash: null, extractedAt: null };

const spec = (extra: object = {}) => ({
  kind: 'spec' as const,
  spec: { functions: [], types: [], errors: [], wasmHash: HASH, ...extra },
});

test('a full spec yields every line', () => {
  const m = buildProvenanceModel(
    spec({
      build: { rustVersion: '1.91.1', sdkVersion: '26.1.0#175aa41' },
      env: { protocolVersion: 23, preRelease: 0 },
      sdkVersion: '16.1.0',
    }),
    { ...base, extractedAt: new Date('2026-03-10T14:02:55Z') },
  );
  assert.ok(m);
  assert.equal(m.wasmHash, HASH);
  assert.equal(m.built, 'Built with Rust 1.91.1 · soroban-sdk 26.1.0#175aa41');
  assert.equal(m.protocol, 'Targets protocol 23');
  assert.deepEqual(m.reader, { sdkVersion: '16.1.0', extractedAt: '2026-03-10T14:02:55.000Z' });
});

test('a spec without metadata states only the hash (no "unknown")', () => {
  const m = buildProvenanceModel(spec(), base);
  assert.ok(m);
  assert.equal(m.built, null);
  assert.equal(m.protocol, null);
  assert.equal(m.reader, null);
  assert.doesNotMatch(JSON.stringify(m), /unknown/i);
});

test('partial build metadata and pre-release protocol are stated as found', () => {
  const m = buildProvenanceModel(
    spec({ build: { sdkVersion: '26.1.0' }, env: { protocolVersion: 24, preRelease: 2 } }),
    base,
  );
  assert.equal(m?.built, 'Built with soroban-sdk 26.1.0');
  assert.equal(m?.protocol, 'Targets protocol 24 (pre-release 2)');
});

test('the explorer link comes from stellarExpertContractUrl on the contract network', () => {
  assert.equal(
    buildProvenanceModel(spec(), base)?.explorerUrl,
    stellarExpertContractUrl(ADDRESS, 'testnet'),
  );
  assert.equal(
    buildProvenanceModel(spec(), { ...base, network: 'mainnet' })?.explorerUrl,
    stellarExpertContractUrl(ADDRESS, 'public'),
  );
});

test('re-derive commands name the address, network and hash', () => {
  const m = buildProvenanceModel(spec(), { ...base, network: 'mainnet' });
  assert.deepEqual(m?.commands, [
    `stellar contract fetch --id ${ADDRESS} --network mainnet --out-file contract.wasm`,
    `sha256sum contract.wasm   # expect ${HASH}`,
    'stellar contract info interface --wasm contract.wasm',
  ]);
});

test('without a spec the indexed hash is used; with neither there is no strip', () => {
  const failure = { kind: 'failure' as const, failure: { kind: 'no_interface' as const } };
  assert.equal(
    buildProvenanceModel(failure, { ...base, indexedWasmHash: HASH.toUpperCase() })?.wasmHash,
    HASH,
  );
  assert.equal(buildProvenanceModel(failure, base), null);
});

test('formatExtractedAt is a fixed UTC format', () => {
  assert.equal(formatExtractedAt('2026-03-10T14:02:55.000Z'), '2026-03-10 14:02 UTC');
});
