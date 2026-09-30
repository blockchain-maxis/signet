import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  PrismaSpecCache,
  RUNNING_SDK_VERSION,
  SPEC_SCHEMA_VERSION,
  compareSdkVersions,
  isStale,
  type SpecStore,
  type StoredSpec,
  type StoredSpecRow,
} from './spec-store.ts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** In-memory stand-in for the `ContractSpec` table. */
function fakeStore(): { store: SpecStore; rows: Map<string, StoredSpecRow> } {
  const rows = new Map<string, StoredSpecRow>();
  const store: SpecStore = {
    contractSpec: {
      async findUnique({ where }) {
        return rows.get(where.wasmHash) ?? null;
      },
      async upsert({ where, create, update }) {
        const existing = rows.get(where.wasmHash);
        rows.set(
          where.wasmHash,
          existing ? { wasmHash: where.wasmHash, ...update } : { ...create },
        );
      },
    },
  };
  return { store, rows };
}

function spec(overrides: Partial<StoredSpec> = {}): StoredSpec {
  return {
    schemaVersion: SPEC_SCHEMA_VERSION,
    sdkVersion: RUNNING_SDK_VERSION,
    specJson: { schemaVersion: SPEC_SCHEMA_VERSION, wasmHash: HASH_A },
    ...overrides,
  };
}

test('a miss returns undefined', async () => {
  const { store } = fakeStore();
  const cache = new PrismaSpecCache(store);
  assert.equal(await cache.get(HASH_A), undefined);
});

test('set then get round-trips the payload with its key and timestamp', async () => {
  const { store, rows } = fakeStore();
  const cache = new PrismaSpecCache(store);
  const payload = spec();

  await cache.set(HASH_A, payload);

  const row = await cache.get(HASH_A);
  assert.ok(row, 'row is stored');
  assert.equal(row.wasmHash, HASH_A);
  assert.equal(row.schemaVersion, payload.schemaVersion);
  assert.equal(row.sdkVersion, payload.sdkVersion);
  assert.deepEqual(row.specJson, payload.specJson);
  assert.ok(row.extractedAt instanceof Date);

  assert.equal(await cache.get(HASH_B), undefined, 'other keys are untouched');
  assert.equal(rows.size, 1);
});

test('set overwrites an existing row rather than accumulating', async () => {
  const { store, rows } = fakeStore();
  const cache = new PrismaSpecCache(store);

  await cache.set(HASH_A, spec({ sdkVersion: '0.0.1' }));
  await cache.set(HASH_A, spec());

  assert.equal(rows.size, 1);
  const row = await cache.get(HASH_A);
  assert.equal(row?.sdkVersion, RUNNING_SDK_VERSION);
});

test('a stale-SDK row is reported stale; a stale schemaVersion too', () => {
  assert.equal(
    isStale({ schemaVersion: SPEC_SCHEMA_VERSION, sdkVersion: '0.0.1' }),
    true,
    'an older SDK than the running one is stale',
  );
  assert.equal(
    isStale({ schemaVersion: SPEC_SCHEMA_VERSION - 1, sdkVersion: RUNNING_SDK_VERSION }),
    true,
    'a schemaVersion below current is stale',
  );
});

test('a current row is not stale', () => {
  assert.equal(
    isStale({ schemaVersion: SPEC_SCHEMA_VERSION, sdkVersion: RUNNING_SDK_VERSION }),
    false,
  );
});

test('RUNNING_SDK_VERSION matches the installed @stellar/stellar-sdk', () => {
  const require = createRequire(import.meta.url);
  let dir = dirname(require.resolve('@stellar/stellar-sdk'));
  for (;;) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === '@stellar/stellar-sdk') {
        assert.equal(
          RUNNING_SDK_VERSION,
          pkg.version,
          'a stellar-sdk dependency bump must update RUNNING_SDK_VERSION',
        );
        return;
      }
    }
    const parent = dirname(dir);
    assert.notEqual(parent, dir, 'found @stellar/stellar-sdk package.json');
    dir = parent;
  }
});

test('compareSdkVersions orders numerically and treats prereleases as older', () => {
  assert.equal(compareSdkVersions('16.1.0', '16.1.0'), 0);
  assert.equal(compareSdkVersions('16.1.0', '16.1.10'), -1, 'numeric, not lexicographic');
  assert.equal(compareSdkVersions('16.2.0', '16.1.9'), 1);
  assert.equal(compareSdkVersions('16.1', '16.1.0'), 0, 'missing segments count as zero');
  assert.equal(compareSdkVersions('16.1.0-rc.1', '16.1.0'), -1, 'prerelease < release');
  assert.equal(compareSdkVersions('17.0.0', '16.1.0'), 1);
});

test('without a database, get is a miss and set is a no-op', async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const cache = new PrismaSpecCache();
    assert.equal(await cache.get(HASH_A), undefined);
    await assert.doesNotReject(() => cache.set(HASH_A, spec()));
    assert.equal(await cache.get(HASH_A), undefined);
  } finally {
    if (previous !== undefined) process.env.DATABASE_URL = previous;
  }
});
