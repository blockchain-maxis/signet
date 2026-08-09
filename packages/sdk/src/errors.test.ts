import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignetError, NotFoundError, NetworkError, ApiError } from './errors.ts';

test('every typed error extends SignetError and Error', () => {
  for (const err of [new NotFoundError(), new NetworkError(), new ApiError('boom', 500)]) {
    assert.ok(err instanceof SignetError);
    assert.ok(err instanceof Error);
  }
});

test('each error reports its own class name', () => {
  assert.equal(new NotFoundError().name, 'NotFoundError');
  assert.equal(new NetworkError().name, 'NetworkError');
  assert.equal(new ApiError('x', 502).name, 'ApiError');
});

test('NotFoundError has status 404', () => {
  assert.equal(new NotFoundError().status, 404);
});

test('ApiError carries the response status', () => {
  assert.equal(new ApiError('bad gateway', 502).status, 502);
});

test('callers can discriminate between error kinds', () => {
  const err: unknown = new ApiError('nope', 500);
  assert.ok(err instanceof ApiError);
  assert.ok(!(err instanceof NotFoundError));
  assert.ok(!(err instanceof NetworkError));
});
