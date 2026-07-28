import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRegistryConfigured, lookupHandleOnchain } from './registry-read.ts';

test('isRegistryConfigured is false when the registry id is unset', () => {
  delete process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID;
  assert.equal(isRegistryConfigured(), false);
});

test('isRegistryConfigured reflects a configured id', () => {
  process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';
  try {
    assert.equal(isRegistryConfigured(), true);
  } finally {
    delete process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID;
  }
});

test('lookupHandleOnchain returns null when unconfigured (no network call, honest empty state)', async () => {
  delete process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID;
  assert.equal(
    await lookupHandleOnchain('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'),
    null,
  );
});
