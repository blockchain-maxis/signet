import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AttributedContract } from './contract-attribution.ts';
import { buildHeaderModel } from './contract-header.ts';

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);

const contract = (wasmHash: string | null, network = 'testnet'): AttributedContract => ({
  address: 'CDEMO',
  network,
  deployerPubkey: 'GDEPLOYERPUBKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  deployTxHash: 'deadbeef',
  deployedAt: '2026-03-01T12:00:00.000Z',
  wasmHash,
});

const opts = { handle: 'aquawolf', configuredNetwork: 'testnet', indexedAsOf: '2026-03-10T12:00:00.000Z' };

test('live only: shows the live hash, labelled as read from the ledger', () => {
  const { wasm } = buildHeaderModel(contract(null), NEW, opts);
  assert.deepEqual(wasm, { state: 'live', hash: NEW, label: 'current, read from ledger', note: null });
});

test('indexed only: shows the indexed hash with its date', () => {
  const { wasm } = buildHeaderModel(contract(OLD), null, opts);
  assert.equal(wasm.state, 'indexed');
  assert.equal(wasm.hash, OLD);
  assert.equal(wasm.label, 'as of 10 Mar 2026');
  assert.equal(wasm.note, null);
});

test('indexed only without a check date: says "as last indexed", never a made-up date', () => {
  const { wasm } = buildHeaderModel(contract(OLD), null, { handle: 'a', configuredNetwork: 'testnet' });
  assert.equal(wasm.label, 'as last indexed');
});

test('both agree: live label, no upgrade note (case-insensitive)', () => {
  const { wasm } = buildHeaderModel(contract(OLD), OLD.toUpperCase(), opts);
  assert.equal(wasm.state, 'live');
  assert.equal(wasm.hash, OLD.toUpperCase());
  assert.equal(wasm.label, 'current, read from ledger');
  assert.equal(wasm.note, null);
});

test('both disagree: shows the live hash and notes the upgrade', () => {
  const { wasm } = buildHeaderModel(contract(OLD), NEW, opts);
  assert.equal(wasm.hash, NEW);
  assert.equal(wasm.label, 'current, read from ledger');
  assert.equal(
    wasm.note,
    'Upgraded since indexing: the index recorded aaaaaaaa...aaaaaaaa as of 10 Mar 2026.',
  );
});

test('neither: the field says unavailable, never blank', () => {
  const { wasm } = buildHeaderModel(contract(null), null, opts);
  assert.deepEqual(wasm, {
    state: 'unavailable',
    hash: null,
    label: 'unavailable (RPC unreachable)',
    note: null,
  });
});

test('network: matching network is unremarkable, a different one is flagged', () => {
  assert.deepEqual(buildHeaderModel(contract(OLD), null, opts).network, {
    value: 'testnet',
    mismatch: false,
    note: null,
  });
  const bad = buildHeaderModel(contract(OLD, 'mainnet'), null, opts).network;
  assert.equal(bad.mismatch, true);
  assert.match(bad.note ?? '', /on mainnet, but this deployment serves testnet/);
});

test("links use the contract's own network, and the date is formatted", () => {
  const m = buildHeaderModel(contract(OLD, 'mainnet'), null, opts);
  assert.equal(m.addressUrl, 'https://stellar.expert/explorer/public/contract/CDEMO');
  assert.equal(m.deployTx.url, 'https://stellar.expert/explorer/public/tx/deadbeef');
  assert.match(m.deployer.url, /explorer\/public\/account\/GDEPLOYER/);
  assert.equal(m.deployedOn, '1 Mar 2026');
  assert.equal(m.deployer.display, 'GDEPLOYE...AAAAAA');
  assert.equal(m.handle, 'aquawolf');
});

test('a live instance is not archived', () => {
  const m = buildHeaderModel(contract(OLD), NEW, opts);
  assert.equal(m.archived, null);
});

test('archived: the header says "archived on {network}" and the hash is labelled as last recorded', () => {
  const m = buildHeaderModel(contract(OLD), OLD, { ...opts, archived: true });

  assert.equal(m.archived?.label, 'archived on testnet');
  assert.match(m.archived?.note ?? '', /expired on testnet/);
  assert.match(m.archived?.note ?? '', /restored/);
  assert.equal(m.wasm.state, 'archived');
  assert.equal(m.wasm.hash, OLD);
  assert.equal(m.wasm.label, 'last recorded on the ledger (archived)');
  assert.equal(m.wasm.note, null, 'no "upgraded" claim from an expired entry');
});

test('archived: names the contract\'s own network, not the one this deployment serves', () => {
  const m = buildHeaderModel(contract(OLD, 'mainnet'), OLD, { ...opts, archived: true });
  assert.equal(m.archived?.label, 'archived on mainnet');
});

test('archived with no readable hash still says so, and the hash field falls back to the index', () => {
  const m = buildHeaderModel(contract(OLD), null, { ...opts, archived: true });

  assert.equal(m.archived?.label, 'archived on testnet');
  assert.equal(m.wasm.state, 'indexed');
  assert.equal(m.wasm.hash, OLD);
});

test('archived: false and omitted behave the same', () => {
  assert.equal(buildHeaderModel(contract(OLD), NEW, { ...opts, archived: false }).archived, null);
  assert.equal(buildHeaderModel(contract(OLD), NEW, opts).archived, null);
});
