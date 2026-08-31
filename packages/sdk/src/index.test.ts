import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from './index.ts';

/**
 * Regression test for the public export surface. `types.ts` deliberately
 * curates what it re-exports from `@signet/types` instead of `export *`-ing
 * everything — see the comment there for why. This asserts the boundary at
 * runtime so a careless `export *` (or a new accidental re-export) fails a
 * test instead of silently becoming part of the next npm publish.
 */

test('does not leak @signet/types internals (validation helpers, demo fixtures, its own version marker)', () => {
  const leaked = [
    'DEMO_PROFILES',
    'SIGNET_TYPES_VERSION',
    'HANDLE_MAX_LEN',
    'HANDLE_PATTERN',
    'RESERVED_HANDLES',
    'isClaimableHandle',
    'isReservedHandle',
    'isValidHandle',
  ];
  for (const name of leaked) {
    assert.equal(name in sdk, false, `${name} should not be part of the public SDK surface`);
  }
});

test('exports the deliberate public surface: the client, its errors, and nothing else at runtime', () => {
  assert.deepEqual(Object.keys(sdk).sort(), [
    'ApiError',
    'NetworkError',
    'NotFoundError',
    'SignetClient',
    'SignetError',
  ]);
});
