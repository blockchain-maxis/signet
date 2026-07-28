import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchProfileHandle } from './profile-path.ts';

test('matchProfileHandle extracts a valid handle from a profile path', () => {
  assert.equal(matchProfileHandle('/p/aquawolf'), 'aquawolf');
  assert.equal(matchProfileHandle('/p/dev_1-two'), 'dev_1-two');
});

test('matchProfileHandle rejects non-profile or malformed paths', () => {
  assert.equal(matchProfileHandle('/'), null);
  assert.equal(matchProfileHandle('/how-it-works'), null);
  assert.equal(matchProfileHandle('/profile/aquawolf'), null);
  assert.equal(matchProfileHandle('/p/'), null);
  assert.equal(matchProfileHandle('/p/aquawolf/contract/abc'), null);
  assert.equal(matchProfileHandle('/p/Not-Valid!'), null);
  assert.equal(matchProfileHandle(null), null);
});
