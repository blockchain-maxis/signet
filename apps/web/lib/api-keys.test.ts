import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  verifyApiKey,
  hashApiKey,
  timingSafeEqualString,
  API_KEY_REGEX,
  API_KEY_PATTERN,
  API_KEY_PREFIX,
  type ApiKeyRecord,
  type ApiKeyStore,
} from './api-keys.ts';
import { withV1, ok } from './api/v1/http.ts';
import { logger } from './logger.ts';
import { LIMITS } from './rate-limit-policy.ts';
import { __resetRateLimit } from './rate-limit.ts';

function createMockStore(initialKeys: ApiKeyRecord[] = []): ApiKeyStore & { keys: ApiKeyRecord[] } {
  const keys = [...initialKeys];
  return {
    keys,
    async create(data) {
      const record: ApiKeyRecord = {
        id: `key_${keys.length + 1}`,
        profileId: data.profileId,
        name: data.name,
        prefix: data.prefix,
        hash: data.hash,
        createdAt: new Date(),
        lastUsedAt: null,
        revokedAt: null,
      };
      keys.push(record);
      return record;
    },
    async listByProfile(profileId) {
      return keys.filter((k) => k.profileId === profileId);
    },
    async findByPrefix(prefix) {
      return keys.filter((k) => k.prefix === prefix);
    },
    async revoke(profileId, id) {
      const key = keys.find((k) => k.id === id && k.profileId === profileId);
      if (!key) return null;
      key.revokedAt = new Date();
      return key;
    },
    async touchLastUsed(id, date) {
      const key = keys.find((k) => k.id === id);
      if (key) {
        key.lastUsedAt = date;
      }
    },
  };
}

test('createApiKey() creates sgk_ key with 8-char prefix and returns plaintext once', async () => {
  const store = createMockStore();
  const { key, record } = await createApiKey('prof_123', 'Integration Key', store);

  assert.ok(key.startsWith('sgk_'), 'Key starts with sgk_');
  const match = key.match(API_KEY_REGEX);
  assert.ok(match && match[1], 'Key matches API_KEY_REGEX');
  assert.equal(match[1].length, 8, 'Prefix length is 8 characters');
  assert.equal(record.prefix, match[1]);
  assert.equal(record.name, 'Integration Key');
  assert.equal(record.profileId, 'prof_123');
  assert.equal(record.hash, hashApiKey(key), 'Record stores SHA-256 hash of plaintext key');
  assert.equal(record.revokedAt, null);
  assert.equal(record.lastUsedAt, null);

  // Stored record in mock store does not contain plaintext key
  const saved = store.keys[0];
  assert.ok(saved);
  assert.ok(!('key' in saved));
  assert.equal(saved.hash, hashApiKey(key));
});

test('createApiKey() rejects blank key names', async () => {
  const store = createMockStore();
  await assert.rejects(
    async () => {
      await createApiKey('prof_123', '   ', store);
    },
    { message: /name must not be empty/ },
  );
});

test('listApiKeys() returns all keys belonging to a profile', async () => {
  const store = createMockStore();
  await createApiKey('prof_1', 'Key 1', store);
  await createApiKey('prof_1', 'Key 2', store);
  await createApiKey('prof_2', 'Key 3', store);

  const prof1Keys = await listApiKeys('prof_1', store);
  assert.equal(prof1Keys.length, 2);
  assert.equal(prof1Keys[0]?.name, 'Key 1');
  assert.equal(prof1Keys[1]?.name, 'Key 2');

  const prof2Keys = await listApiKeys('prof_2', store);
  assert.equal(prof2Keys.length, 1);
  assert.equal(prof2Keys[0]?.name, 'Key 3');
});

test('revokeApiKey() marks an existing key as revoked', async () => {
  const store = createMockStore();
  const { record } = await createApiKey('prof_1', 'To Revoke', store);

  const revoked = await revokeApiKey('prof_1', record.id, store);
  assert.ok(revoked);
  assert.ok(revoked.revokedAt instanceof Date);

  // Revoking again or unknown profile returns null
  const notFound = await revokeApiKey('prof_2', record.id, store);
  assert.equal(notFound, null);
});

test('timingSafeEqualString() constant time comparison', () => {
  const secretA = 'a'.repeat(64);
  const secretB = 'a'.repeat(64);
  const secretC = 'a'.repeat(63) + 'b';
  const secretShort = 'a'.repeat(32);

  assert.equal(timingSafeEqualString(secretA, secretB), true);
  assert.equal(timingSafeEqualString(secretA, secretC), false);
  assert.equal(timingSafeEqualString(secretA, secretShort), false);
  assert.equal(timingSafeEqualString('', ''), true);
});

test('verifyApiKey() validates matching key and rejects invalid or revoked keys', async () => {
  const store = createMockStore();
  const { key, record } = await createApiKey('prof_1', 'Test', store);

  // 1. Valid key
  const valid = await verifyApiKey(key, store);
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.record.id, record.id);
  }

  // 2. Malformed key format
  const malformed = await verifyApiKey('invalid-token', store);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.equal(malformed.code, 'unauthorized');
  }

  // 3. Key with unknown prefix
  const fakeKey = `sgk_00000000_${'a'.repeat(43)}`;
  const unknownPrefix = await verifyApiKey(fakeKey, store);
  assert.equal(unknownPrefix.ok, false);
  if (!unknownPrefix.ok) {
    assert.equal(unknownPrefix.code, 'unauthorized');
  }

  // 4. Key with matching prefix but wrong secret
  const wrongSecretKey = `sgk_${record.prefix}_${'b'.repeat(43)}`;
  const wrongSecret = await verifyApiKey(wrongSecretKey, store);
  assert.equal(wrongSecret.ok, false);
  if (!wrongSecret.ok) {
    assert.equal(wrongSecret.code, 'unauthorized');
  }

  // 5. Revoked key
  await revokeApiKey('prof_1', record.id, store);
  const revoked = await verifyApiKey(key, store);
  assert.equal(revoked.ok, false);
  if (!revoked.ok) {
    assert.equal(revoked.code, 'unauthorized');
    assert.match(revoked.reason, /revoked/i);
  }
});

test('verifyApiKey() throttles lastUsedAt updates to at most once per minute', async () => {
  const store = createMockStore();
  const { key, record } = await createApiKey('prof_1', 'Throttle Test', store);

  // First verification updates lastUsedAt
  await verifyApiKey(key, store);
  const firstTouch = record.lastUsedAt;
  assert.ok(firstTouch instanceof Date);

  // Second verification immediately afterwards does not update lastUsedAt
  await verifyApiKey(key, store);
  assert.equal(record.lastUsedAt, firstTouch);

  // Set lastUsedAt to 65 seconds ago
  record.lastUsedAt = new Date(Date.now() - 65_000);
  const oldTouch = record.lastUsedAt;
  await verifyApiKey(key, store);
  assert.notEqual(record.lastUsedAt, oldTouch);
  assert.ok(record.lastUsedAt!.getTime() > oldTouch.getTime());
});

test('withV1 handles valid API key: elevates rate limit and uses keyed bucket', async () => {
  __resetRateLimit();
  const store = createMockStore();
  const { key } = await createApiKey('prof_1', 'Keyed Caller', store);

  const handler = withV1(() => ok({ status: 'ok' }), { apiKeyStore: store });
  const req = new Request('http://localhost:3000/api/v1/test', {
    headers: {
      Authorization: `Bearer ${key}`,
    },
  });

  const res = await handler(req);
  assert.equal(res.status, 200);

  // Rate limit headers reflect elevated LIMITS.v1Keyed
  const limitHeader = res.headers.get('RateLimit-Limit');
  assert.equal(limitHeader, String(LIMITS.v1Keyed));
  assert.equal(Number(limitHeader) >= 300, true);
});

test('withV1 handles anonymous request: uses anonymous per-IP bucket', async () => {
  __resetRateLimit();
  const handler = withV1(() => ok({ status: 'ok' }));
  const req = new Request('http://localhost:3000/api/v1/test', {
    headers: {
      'x-forwarded-for': '198.51.100.10',
    },
  });

  const res = await handler(req);
  assert.equal(res.status, 200);

  const limitHeader = res.headers.get('RateLimit-Limit');
  assert.equal(limitHeader, String(LIMITS.v1Read));
  assert.equal(limitHeader, '60');
});

test('withV1 rejects invalid or revoked API key with 401 unauthorized', async () => {
  const store = createMockStore();
  const { key, record } = await createApiKey('prof_1', 'Revoked', store);
  await revokeApiKey('prof_1', record.id, store);

  const handler = withV1(() => ok({ status: 'ok' }), { apiKeyStore: store });

  // 1. Revoked key
  const reqRevoked = new Request('http://localhost:3000/api/v1/test', {
    headers: { Authorization: `Bearer ${key}` },
  });
  const resRevoked = await handler(reqRevoked);
  assert.equal(resRevoked.status, 401);
  const bodyRevoked = (await resRevoked.json()) as { error: { code: string } };
  assert.equal(bodyRevoked.error.code, 'unauthorized');

  // 2. Malformed token
  const reqBad = new Request('http://localhost:3000/api/v1/test', {
    headers: { Authorization: 'Bearer not-an-sgk-key' },
  });
  const resBad = await handler(reqBad);
  assert.equal(resBad.status, 401);
  const bodyBad = (await resBad.json()) as { error: { code: string } };
  assert.equal(bodyBad.error.code, 'unauthorized');

  // 3. Non-Bearer header
  const reqBasic = new Request('http://localhost:3000/api/v1/test', {
    headers: { Authorization: 'Basic dXNlcjpwYXNz' },
  });
  const resBasic = await handler(reqBasic);
  assert.equal(resBasic.status, 401);
});

test('plaintext API key is never logged anywhere in logger calls', async () => {
  const store = createMockStore();
  const { key } = await createApiKey('prof_1', 'Secret Key', store);

  const loggedLines: string[] = [];
  const originalError = logger.error;
  const originalWarn = logger.warn;
  const originalInfo = logger.info;
  const originalDebug = logger.debug;

  const spy = (fields: Record<string, unknown>, msg: string) => {
    loggedLines.push(JSON.stringify(fields) + ' ' + msg);
  };

  logger.error = spy as typeof logger.error;
  logger.warn = spy as typeof logger.warn;
  logger.info = spy as typeof logger.info;
  logger.debug = spy as typeof logger.debug;

  try {
    const handler = withV1(
      () => {
        throw new Error('Explosion');
      },
      { apiKeyStore: store },
    );

    const req = new Request('http://localhost:3000/api/v1/fail', {
      headers: { Authorization: `Bearer ${key}` },
    });

    const res = await handler(req);
    assert.equal(res.status, 500);

    // Verify key never appeared in any log call
    for (const line of loggedLines) {
      assert.equal(line.includes(key), false, `Plaintext key was logged: ${line}`);
      assert.equal(line.includes('sgk_'), false, `sgk_ token was logged: ${line}`);
    }
  } finally {
    logger.error = originalError;
    logger.warn = originalWarn;
    logger.info = originalInfo;
    logger.debug = originalDebug;
  }
});

test('API_KEY_RATE_LIMIT_PER_MIN env var configures LIMITS.v1Keyed', () => {
  const originalEnv = process.env.API_KEY_RATE_LIMIT_PER_MIN;

  try {
    delete process.env.API_KEY_RATE_LIMIT_PER_MIN;
    assert.equal(LIMITS.v1Keyed, 300);

    process.env.API_KEY_RATE_LIMIT_PER_MIN = '1200';
    assert.equal(LIMITS.v1Keyed, 1200);

    process.env.API_KEY_RATE_LIMIT_PER_MIN = 'invalid';
    assert.equal(LIMITS.v1Keyed, 300);
  } finally {
    if (originalEnv !== undefined) {
      process.env.API_KEY_RATE_LIMIT_PER_MIN = originalEnv;
    } else {
      delete process.env.API_KEY_RATE_LIMIT_PER_MIN;
    }
  }
});
