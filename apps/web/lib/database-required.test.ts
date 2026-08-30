import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  DATABASE_REQUIRED_CODE,
  DatabaseRequiredError,
  isDatabaseConfigured,
  requireDatabase,
  safeDbProfile,
} from './profiles.ts';

const original = process.env.DATABASE_URL;

afterEach(() => {
  if (original === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = original;
});

test('isDatabaseConfigured tracks DATABASE_URL', () => {
  delete process.env.DATABASE_URL;
  assert.equal(isDatabaseConfigured(), false);

  process.env.DATABASE_URL = 'postgres://localhost:5432/signet';
  assert.equal(isDatabaseConfigured(), true);
});

test('requireDatabase throws a typed, classifiable error when unconfigured', () => {
  delete process.env.DATABASE_URL;

  assert.throws(
    () => requireDatabase('CLI wallet linking'),
    (err: unknown) => {
      assert.ok(err instanceof DatabaseRequiredError);
      assert.equal(err.code, DATABASE_REQUIRED_CODE);
      // The flag is what lets a client say "deployment problem" without
      // string-matching prose.
      assert.equal(err.isConfigurationError, true);
      assert.match(err.message, /requires a database/);
      // Points at the fix and at #191, so the message is actionable by
      // whoever can actually act on it.
      assert.match(err.message, /DATABASE_URL/);
      assert.match(err.message, /#191/);
      return true;
    },
  );
});

test('requireDatabase is a no-op once a database is configured', () => {
  process.env.DATABASE_URL = 'postgres://localhost:5432/signet';
  assert.doesNotThrow(() => requireDatabase('CLI wallet linking'));
});

test('the read path still degrades gracefully — this changes writes only', async () => {
  delete process.env.DATABASE_URL;
  // The whole point of #277 is that the two paths differ: reads fall through,
  // writes fail closed. A regression that made reads throw would break every
  // preview deployment.
  assert.equal(await safeDbProfile('aquawolf'), null);
});
