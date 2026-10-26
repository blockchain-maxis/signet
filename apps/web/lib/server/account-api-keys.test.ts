import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiKeyRecord, ApiKeyStore } from '../api-keys.ts';
import { verifyApiKey } from '../api-keys.ts';
import {
  ApiKeyAccountError,
  MAX_ACTIVE_API_KEYS,
  createAccountApiKey,
  listAccountApiKeys,
  revokeAccountApiKey,
  type AccountApiKeyDeps,
} from './account-api-keys.ts';

const ALICE = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const BOB = 'GCQZFJACBU5UII4ZDTFVVE3EPSGPOZYHMY2THOYJ57WYX6D2AQNEQINU';
const NOBODY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

/** An in-memory key table, and alice's and bob's profiles. */
function deps(): AccountApiKeyDeps & { rows: ApiKeyRecord[] } {
  const rows: ApiKeyRecord[] = [];
  let n = 0;
  const store: ApiKeyStore = {
    create: async (data) => {
      const r = {
        id: `k${++n}`,
        createdAt: new Date(Date.UTC(2026, 9, n)),
        lastUsedAt: null,
        revokedAt: null,
        ...data,
      };
      rows.push(r);
      return r;
    },
    listByProfile: async (p) => rows.filter((r) => r.profileId === p).reverse(),
    findByPrefix: async (prefix) => rows.filter((r) => r.prefix === prefix),
    revoke: async (p, id) => {
      const r = rows.find((x) => x.id === id && x.profileId === p);
      if (!r) return null;
      r.revokedAt = new Date();
      return r;
    },
    touchLastUsed: async () => {},
  };
  const profiles: Record<string, string> = { [ALICE]: 'p-alice', [BOB]: 'p-bob' };
  return { rows, store, findProfileId: async (a) => profiles[a] ?? null };
}

test('create returns the full key once; the list shows only its prefix', async () => {
  const d = deps();
  const { key, apiKey } = await createAccountApiKey(ALICE, '  ci  ', d);
  assert.match(key, /^sgk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/);
  assert.equal(apiKey.name, 'ci');
  assert.ok(key.startsWith(apiKey.prefix));
  const listed = await listAccountApiKeys(ALICE, d);
  assert.deepEqual(listed, [apiKey]);
  assert.equal(JSON.stringify(listed).includes(key), false, 'the list never carries the key');
  assert.equal(JSON.stringify(listed).includes(d.rows[0]!.hash), false, 'nor its hash');
  // The key it returned is the one the API accepts.
  const verified = await verifyApiKey(key, d.store);
  assert.equal(verified.ok, true);
});

test('revoking removes a key from the active list, and the API refuses it', async () => {
  const d = deps();
  const { key, apiKey } = await createAccountApiKey(ALICE, 'old', d);
  await revokeAccountApiKey(ALICE, apiKey.id, d);
  assert.deepEqual(await listAccountApiKeys(ALICE, d), []);
  const verified = await verifyApiKey(key, d.store);
  assert.equal(verified.ok, false);
});

test(`the ${MAX_ACTIVE_API_KEYS + 1}th active key is refused; a revoked one frees a slot`, async () => {
  const d = deps();
  const made = [];
  for (let i = 0; i < MAX_ACTIVE_API_KEYS; i++)
    made.push(await createAccountApiKey(ALICE, `k${i}`, d));
  await assert.rejects(
    createAccountApiKey(ALICE, 'one too many', d),
    (err: unknown) =>
      err instanceof ApiKeyAccountError && err.reason === 'limit' && /Revoke one/.test(err.message),
  );
  await revokeAccountApiKey(ALICE, made[0]!.apiKey.id, d);
  await createAccountApiKey(ALICE, 'replacement', d);
  // Bob's limit is his own.
  await createAccountApiKey(BOB, 'bobs', d);
});

test("a wallet cannot revoke another profile's key", async () => {
  const d = deps();
  const { apiKey } = await createAccountApiKey(ALICE, 'mine', d);
  await assert.rejects(
    revokeAccountApiKey(BOB, apiKey.id, d),
    (err: unknown) => err instanceof ApiKeyAccountError && err.reason === 'not-found',
  );
  assert.equal((await listAccountApiKeys(ALICE, d)).length, 1);
});

test('a wallet with no profile has no keys to manage', async () => {
  const d = deps();
  for (const call of [
    () => listAccountApiKeys(NOBODY, d),
    () => createAccountApiKey(NOBODY, 'x', d),
    () => revokeAccountApiKey(NOBODY, 'k1', d),
  ]) {
    await assert.rejects(
      call(),
      (err: unknown) => err instanceof ApiKeyAccountError && err.reason === 'no-profile',
    );
  }
});

test('a name is required and bounded', async () => {
  const d = deps();
  for (const name of ['', '   ', undefined, 'x'.repeat(65)]) {
    await assert.rejects(
      createAccountApiKey(ALICE, name, d),
      (err: unknown) => err instanceof ApiKeyAccountError && err.reason === 'invalid-name',
    );
  }
  assert.equal(d.rows.length, 0);
});
