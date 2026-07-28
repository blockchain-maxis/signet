import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceBindings, listDirectory, isRegistryConfigured } from './directory.ts';

test('reduceBindings keeps only the currently-bound handles', () => {
  const events = [
    { kind: 'claimed' as const, handle: 'aquawolf', wallet: 'GAAA' },
    { kind: 'claimed' as const, handle: 'sorobuilder', wallet: 'GBBB' },
    { kind: 'released' as const, handle: 'aquawolf', wallet: 'GAAA' },
  ];
  const bound = reduceBindings(events);
  assert.deepEqual(
    bound.map((e) => e.handle),
    ['sorobuilder'],
  );
});

test('reduceBindings lets a handle be re-claimed after release', () => {
  const events = [
    { kind: 'claimed' as const, handle: 'aquawolf', wallet: 'GAAA' },
    { kind: 'released' as const, handle: 'aquawolf', wallet: 'GAAA' },
    { kind: 'claimed' as const, handle: 'aquawolf', wallet: 'GBBB' },
  ];
  const bound = reduceBindings(events);
  assert.equal(bound.length, 1);
  assert.equal(bound[0]!.wallet, 'GBBB');
});

test('reduceBindings sorts alphabetically for stable pagination', () => {
  const events = [
    { kind: 'claimed' as const, handle: 'zeta', wallet: 'GAAA' },
    { kind: 'claimed' as const, handle: 'alpha', wallet: 'GBBB' },
  ];
  const bound = reduceBindings(events);
  assert.deepEqual(
    bound.map((e) => e.handle),
    ['alpha', 'zeta'],
  );
});

test('reduceBindings returns nothing for an empty event list (empty-state case)', () => {
  assert.deepEqual(reduceBindings([]), []);
});

test('isRegistryConfigured is false without a contract id set', () => {
  // No REGISTRY_CONTRACT_ID / NEXT_PUBLIC_IDENTITY_REGISTRY_ID in this test env.
  assert.equal(isRegistryConfigured(), false);
});

test('listDirectory falls back to the curated manifest when the registry is unconfigured', async () => {
  const entries = await listDirectory();
  const handles = entries.map((e) => e.handle);
  assert.ok(handles.includes('aquawolf'));
  assert.ok(handles.length >= 3);
  // Falls back to the curated set, so entries won't carry a wallet address.
  assert.equal(entries.find((e) => e.handle === 'aquawolf')?.wallet, '');
});
