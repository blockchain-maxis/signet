import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCallCommand, shellQuote } from './command.ts';

const CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const WALLET = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

test('shellQuote single-quotes values and escapes embedded single quotes', () => {
  assert.equal(shellQuote('plain'), "'plain'");
  assert.equal(shellQuote("it's a 'test'"), `'it'\\''s a '\\''test'\\'''`);
});

test('buildCallCommand omits default flags and formats primitives, addresses, structs, vecs and single quotes', () => {
  const cmd = buildCallCommand({
    contract: CONTRACT,
    fn: 'complex',
    args: {
      label: "alice's token",
      count: 42,
      owner: WALLET,
      tags: ['alpha', 'beta'],
      meta: { nested: { flag: true, note: "can't stop" } },
    },
    authMode: 'record',
    sourceAccount: '',
    ledgerSequence: '',
    ledgerTimestamp: '',
    network: 'testnet',
    runOn: 'deployed',
  });

  assert.equal(
    cmd,
    [
      'signet sandbox call',
      CONTRACT,
      'complex',
      `--arg 'label="alice'\\''s token"'`,
      `--arg 'count=42'`,
      `--arg 'owner="${WALLET}"'`,
      `--arg 'tags=["alpha","beta"]'`,
      `--arg 'meta={"nested":{"flag":true,"note":"can'\\''t stop"}}'`,
      '--network testnet',
    ].join(' '),
  );
  assert.ok(!cmd.includes('--auth'));
  assert.ok(!cmd.includes('--source-account'));
  assert.ok(!cmd.includes('--ledger-seq'));
  assert.ok(!cmd.includes('--timestamp'));
  assert.ok(!cmd.includes('--wasm'));
});

test('buildCallCommand includes non-default options and local wasm path', () => {
  const cmd = buildCallCommand({
    contract: CONTRACT,
    fn: 'claim',
    args: { handle: 'alice' },
    authMode: 'strict',
    sourceAccount: WALLET,
    ledgerSequence: '12345',
    ledgerTimestamp: '1700000000',
    network: 'mainnet',
    runOn: 'local',
    buildPath: 'target/wasm32v1-none/release/my contract.wasm',
  });

  assert.equal(
    cmd,
    [
      'signet sandbox call',
      CONTRACT,
      'claim',
      `--arg 'handle="alice"'`,
      '--auth strict',
      `--source-account ${WALLET}`,
      '--ledger-seq 12345',
      '--timestamp 1700000000',
      '--network mainnet',
      `--wasm 'target/wasm32v1-none/release/my contract.wasm'`,
    ].join(' '),
  );
});

test('buildCallCommand adds a comment line when runOn is local without a build path', () => {
  const cmd = buildCallCommand({
    contract: CONTRACT,
    fn: 'count',
    args: {},
    runOn: 'local',
    buildPath: '',
  });
  const lines = cmd.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.startsWith('# ') && lines[0]!.includes('--wasm'));
  assert.equal(lines[1], `signet sandbox call ${CONTRACT} count`);
});
