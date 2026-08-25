import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMainnetNetwork, checkNetworkUrls, assertNetworkUrls } from './network-guard.ts';
import { loadConfig } from './config.ts';

const TESTNET_RPC = 'https://soroban-testnet.stellar.org';
const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
const MAINNET_HORIZON = 'https://horizon.stellar.org';
const PAID_MAINNET_RPC = 'https://soroban-mainnet.example-provider.com/v1/abc123';

test('isMainnetNetwork recognizes mainnet/public/pubnet, case-insensitively', () => {
  for (const n of ['mainnet', 'public', 'pubnet', 'MAINNET']) assert.equal(isMainnetNetwork(n), true, n);
  for (const n of ['testnet', 'futurenet', '']) assert.equal(isMainnetNetwork(n), false, n);
});

test('flags a mainnet network still pointing at a testnet endpoint', () => {
  const msg = checkNetworkUrls('mainnet', [{ label: 'INDEXER_RPC_URL', url: TESTNET_RPC }]);
  assert.ok(msg);
  assert.match(msg!, /INDEXER_RPC_URL/);
  assert.match(msg!, /testnet/);
});

test('does not flag a custom/paid mainnet RPC host on mainnet', () => {
  assert.equal(
    checkNetworkUrls('mainnet', [
      { label: 'INDEXER_RPC_URL', url: PAID_MAINNET_RPC },
      { label: 'INDEXER_HORIZON_URL', url: MAINNET_HORIZON },
    ]),
    null,
  );
});

test('passes when a testnet network uses testnet endpoints', () => {
  assert.equal(
    checkNetworkUrls('testnet', [
      { label: 'INDEXER_RPC_URL', url: TESTNET_RPC },
      { label: 'INDEXER_HORIZON_URL', url: TESTNET_HORIZON },
    ]),
    null,
  );
});

test('assertNetworkUrls throws on mismatch, quiet when consistent', () => {
  assert.throws(() => assertNetworkUrls('public', [{ label: 'INDEXER_RPC_URL', url: TESTNET_RPC }]), /mismatch/i);
  assert.doesNotThrow(() => assertNetworkUrls('testnet', [{ label: 'INDEXER_RPC_URL', url: TESTNET_RPC }]));
});

// ── Surface test: loadConfig() fails fast on a real mismatch ──────────────────

function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const keys = Object.keys(overrides);
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of keys) {
      const prev = saved.get(k);
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

test('loadConfig throws when INDEXER_NETWORK=mainnet but the RPC/Horizon URLs default to testnet', () => {
  withEnv(
    {
      DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
      INDEXER_NETWORK: 'mainnet',
      INDEXER_RPC_URL: undefined,
      INDEXER_HORIZON_URL: undefined,
    },
    () => {
      assert.throws(() => loadConfig(), /mismatch/i);
    },
  );
});

test('loadConfig succeeds when the network and endpoints agree', () => {
  withEnv(
    {
      DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
      INDEXER_NETWORK: 'testnet',
      INDEXER_RPC_URL: TESTNET_RPC,
      INDEXER_HORIZON_URL: TESTNET_HORIZON,
    },
    () => {
      const cfg = loadConfig();
      assert.equal(cfg.network, 'testnet');
      assert.equal(cfg.rpcUrl, TESTNET_RPC);
    },
  );
});
