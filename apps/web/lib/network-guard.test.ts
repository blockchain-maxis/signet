import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMainnetNetwork, checkNetworkUrls, assertNetworkUrls } from './network-guard.ts';

const TESTNET_RPC = 'https://soroban-testnet.stellar.org';
const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
const MAINNET_HORIZON = 'https://horizon.stellar.org';
const PAID_MAINNET_RPC = 'https://soroban-mainnet.example-provider.com/v1/abc123';

test('isMainnetNetwork recognizes mainnet/public/pubnet, case-insensitively', () => {
  for (const n of ['mainnet', 'public', 'pubnet', 'MAINNET', 'Public']) {
    assert.equal(isMainnetNetwork(n), true, n);
  }
  for (const n of ['testnet', 'futurenet', '', 'local']) {
    assert.equal(isMainnetNetwork(n), false, n);
  }
});

test('flags a mainnet network still pointing at a testnet endpoint', () => {
  const msg = checkNetworkUrls('mainnet', [
    { label: 'SOROBAN_RPC_URL', url: TESTNET_RPC },
    { label: 'HORIZON_URL', url: MAINNET_HORIZON },
  ]);
  assert.ok(msg, 'expected a mismatch message');
  assert.match(msg!, /SOROBAN_RPC_URL/);
  assert.match(msg!, /testnet/);
  // The correctly-configured mainnet Horizon URL must not be named.
  assert.doesNotMatch(msg!, /HORIZON_URL/);
});

test('flags a testnet network pointing at a mainnet SDF endpoint', () => {
  const msg = checkNetworkUrls('testnet', [{ label: 'HORIZON_URL', url: MAINNET_HORIZON }]);
  assert.ok(msg);
  assert.match(msg!, /HORIZON_URL/);
  assert.match(msg!, /mainnet/);
});

test('does not flag a custom/paid mainnet RPC host on mainnet', () => {
  // Mainnet Soroban RPC is a paid provider on an arbitrary domain — must not be
  // false-flagged just because it is not an SDF host.
  const msg = checkNetworkUrls('mainnet', [
    { label: 'SOROBAN_RPC_URL', url: PAID_MAINNET_RPC },
    { label: 'HORIZON_URL', url: MAINNET_HORIZON },
  ]);
  assert.equal(msg, null);
});

test('passes when a testnet network uses testnet endpoints', () => {
  assert.equal(
    checkNetworkUrls('testnet', [
      { label: 'SOROBAN_RPC_URL', url: TESTNET_RPC },
      { label: 'HORIZON_URL', url: TESTNET_HORIZON },
    ]),
    null,
  );
});

test('skips empty/unset URLs and ignores unclassifiable hosts', () => {
  assert.equal(
    checkNetworkUrls('mainnet', [
      { label: 'SOROBAN_RPC_URL', url: '' },
      { label: 'CUSTOM', url: 'http://localhost:8000/soroban/rpc' },
    ]),
    null,
  );
});

test('assertNetworkUrls throws on mismatch and is quiet when consistent', () => {
  assert.throws(
    () => assertNetworkUrls('public', [{ label: 'SOROBAN_RPC_URL', url: TESTNET_RPC }]),
    /mismatch/i,
  );
  assert.doesNotThrow(() =>
    assertNetworkUrls('testnet', [{ label: 'SOROBAN_RPC_URL', url: TESTNET_RPC }]),
  );
});
