import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPEC_READER_VERSION } from './index.ts';

test('SPEC_READER_VERSION is a valid semver string', () => {
  assert.equal(typeof SPEC_READER_VERSION, 'string');
  assert.match(SPEC_READER_VERSION, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});
