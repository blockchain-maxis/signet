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
      return (
        err.message.includes('INDEXER_NETWORK') &&
        err.message.includes('moonnet')
      );
    },
  );
});
