import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WALLETS_REFRESH_INTERVAL_MS,
  WALLETS_REFRESH_MAX_MS,
  shouldRefreshWallets,
} from './wallets-refresh.ts';

test('refreshes every 10 seconds for at most 5 minutes', () => {
  assert.equal(WALLETS_REFRESH_INTERVAL_MS, 10_000);
  assert.equal(WALLETS_REFRESH_MAX_MS, 300_000);
});

test('refreshes while a wallet is pending and the window is open', () => {
  assert.equal(shouldRefreshWallets(true, 0), true);
  assert.equal(shouldRefreshWallets(true, WALLETS_REFRESH_MAX_MS - 1), true);
});

test('stops once nothing is pending', () => {
  assert.equal(shouldRefreshWallets(false, 0), false);
  assert.equal(shouldRefreshWallets(false, 30_000), false);
});

test('stops after 5 minutes even if a wallet is still pending', () => {
  assert.equal(shouldRefreshWallets(true, WALLETS_REFRESH_MAX_MS), false);
  assert.equal(shouldRefreshWallets(true, WALLETS_REFRESH_MAX_MS + 1), false);
});
