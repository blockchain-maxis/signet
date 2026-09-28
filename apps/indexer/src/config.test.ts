import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.ts';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.DATABASE_URL = 'postgresql://localhost:5432/signet';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

test('loadConfig normalizes INDEXER_NETWORK=pubnet to mainnet', () => {
  process.env.INDEXER_NETWORK = 'pubnet';
  process.env.INDEXER_RPC_URL = 'https://soroban-mainnet.example.com';
  process.env.INDEXER_HORIZON_URL = 'https://horizon.stellar.org';

  const config = loadConfig();
  assert.equal(config.network, 'mainnet');
});

test('loadConfig throws descriptive error when INDEXER_NETWORK is invalid', () => {
  process.env.INDEXER_NETWORK = 'moonnet';

  assert.throws(
    () => loadConfig(),
    (err: Error) => {
      return err.message.includes('INDEXER_NETWORK') && err.message.includes('moonnet');
    },
  );
});

const numericVariables = [
  { name: 'INDEXER_TICK_INTERVAL_MS', defaultValue: 30_000, min: 1_000, key: 'tickIntervalMs' },
  { name: 'INDEXER_EVENT_WINDOW_LEDGERS', defaultValue: 8_000, min: 1, key: 'eventWindowLedgers' },
  {
    name: 'INDEXER_OPERATIONS_RETENTION_DAYS',
    defaultValue: 90,
    min: 0,
    key: 'operationsRetentionDays',
  },
  {
    name: 'INDEXER_SNAPSHOTS_RETENTION_DAYS',
    defaultValue: 30,
    min: 0,
    key: 'snapshotsRetentionDays',
  },
  {
    name: 'INDEXER_PRUNE_INTERVAL_MS',
    defaultValue: 3_600_000,
    min: 60_000,
    key: 'pruneIntervalMs',
  },
  {
    name: 'INDEXER_EXECUTABLE_REFRESH_MS',
    defaultValue: 21_600_000,
    min: 60_000,
    key: 'executableRefreshIntervalMs',
  },
] as const;

test('loadConfig uses defaults when validated numeric variables are unset', () => {
  for (const { name } of numericVariables) delete process.env[name];

  const config = loadConfig();
  for (const { defaultValue, key } of numericVariables) {
    assert.equal(config[key], defaultValue);
  }
});

for (const { name, min } of numericVariables) {
  test(`loadConfig rejects non-numeric ${name}`, () => {
    process.env[name] = 'not-a-number';

    assert.throws(() => loadConfig(), new RegExp(`${name}.*not-a-number`));
  });

  test(`loadConfig rejects negative ${name}`, () => {
    process.env[name] = '-1';

    assert.throws(() => loadConfig(), new RegExp(`${name}.*-1`));
  });

  test(`loadConfig rejects ${name} below its minimum`, () => {
    process.env[name] = String(min - 1);

    assert.throws(() => loadConfig(), new RegExp(`${name}.*${min - 1}`));
  });
}
