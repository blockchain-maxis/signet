import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildEvents, parseContractSpec, toSpecJson } from '@signet/spec';
import { ContractChanges, type VersionSpecItem } from './contract-changelog.ts';

function loadSpec(file: string) {
  const wasm = readFileSync(
    new URL(`../../../packages/spec/fixtures/${file}`, import.meta.url),
  );
  const parsed = parseContractSpec(wasm);
  return toSpecJson({ ...parsed, events: buildEvents(parsed.entries) });
}

test('ContractChanges renders the decoded upgrade with the expected breaking split', () => {
  const v1 = loadSpec('upgrade_v1.wasm');
  const v2 = loadSpec('upgrade_v2.wasm');
  const versions: VersionSpecItem[] = [
    { wasmHash: v2.wasmHash, observedAt: '2026-11-22T00:00:00Z', spec: v2 },
    { wasmHash: v1.wasmHash, observedAt: '2026-11-21T00:00:00Z', spec: v1 },
  ];

  const html = renderToStaticMarkup(
    React.createElement(ContractChanges, { versions, network: 'testnet' }),
  );
  const cases: ReadonlyArray<readonly [string, boolean]> = [
    ['Added function set_mode', false],
    ['Retyped argument change_amount.inputs[0]', true],
    ['Documentation changed for change_amount.doc', false],
    ['Added field Record.fields.active', true],
    ['Added variant Mode.variants.Paused', true],
    ['Added error UpgradeError.Conflict', false],
    ['Added event Created', false],
    ['Changed event Updated.params[1]', true],
  ];

  for (const [label, breaking] of cases) {
    const item = html.split('<li ').find((candidate) => candidate.includes(label));
    assert.ok(item, `renders ${label}`);
    assert.equal(item.includes('>breaking<'), breaking, `${label} breaking badge`);
  }
});
