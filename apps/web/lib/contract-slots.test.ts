import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotPlaceholder } from './contract-slots.ts';
import type { SpecInput } from './contract-overview.ts';

const spec: SpecInput = { kind: 'spec', spec: { functions: [], types: [], errors: [] } };

test('an unbuilt slot says so and links to the Overview', () => {
  for (const slot of ['functions', 'types', 'diagram'] as const) {
    const p = slotPlaceholder(slot, spec);
    assert.match(p.message, /not built yet/);
    assert.equal(p.reason, null);
    assert.equal(p.link.target, 'overview');
  }
});

test('the placeholder copy never carries example content', () => {
  const p = slotPlaceholder('functions', spec);
  assert.doesNotMatch(p.message, /example|sample|lorem/i);
});

test('a diagram that cannot render says why and links to Functions', () => {
  const failures: SpecInput[] = [
    { kind: 'failure', failure: { kind: 'no_interface' } },
    { kind: 'failure', failure: { kind: 'interface_unreadable', sdkVersion: '14.0.0' } },
    { kind: 'failure', failure: { kind: 'contract_not_found', network: 'testnet' } },
    { kind: 'failure', failure: { kind: 'unavailable' } },
  ];
  for (const input of failures) {
    const p = slotPlaceholder('diagram', input);
    assert.ok(p.reason && p.reason.length > 0);
    assert.equal(p.link.target, 'functions');
  }
});

test('a failed spec does not change the Functions or Types placeholder', () => {
  const failed: SpecInput = { kind: 'failure', failure: { kind: 'no_interface' } };
  assert.equal(slotPlaceholder('functions', failed).link.target, 'overview');
  assert.equal(slotPlaceholder('types', failed).reason, null);
});
