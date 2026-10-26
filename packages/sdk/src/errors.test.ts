import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SignetError,
  NotFoundError,
  ValidationError,
  RateLimitedError,
  UnavailableError,
  NetworkError,
  ApiError,
} from './errors.ts';

const all = () => [
  new NotFoundError(),
  new ValidationError(),
  new RateLimitedError(),
  new UnavailableError(),
  new NetworkError(),
  new ApiError('boom', 500),
];

test('every typed error extends SignetError and Error', () => {
  for (const err of all()) {
    assert.ok(err instanceof SignetError);
    assert.ok(err instanceof Error);
  }
});

test('each error reports its own class name', () => {
  assert.deepEqual(
    all().map((e) => e.name),
    [
      'NotFoundError',
      'ValidationError',
      'RateLimitedError',
      'UnavailableError',
      'NetworkError',
      'ApiError',
    ],
  );
});

test('each server error has its status', () => {
  assert.equal(new NotFoundError().status, 404);
  assert.equal(new ValidationError().status, 400);
  assert.equal(new RateLimitedError().status, 429);
  assert.equal(new UnavailableError().status, 503);
  assert.equal(new ApiError('bad gateway', 502).status, 502);
});

test('server errors carry the envelope code; ValidationError the parameter', () => {
  assert.equal(new NotFoundError('x', { code: 'not_found' }).code, 'not_found');
  assert.equal(new ApiError('x', 500, { code: 'internal' }).code, 'internal');
  assert.equal(new ApiError('x', 500).code, undefined);
  const invalid = new ValidationError('x', { code: 'bad_request', parameter: 'cursor' });
  assert.equal(invalid.code, 'bad_request');
  assert.equal(invalid.parameter, 'cursor');
});

test('RateLimitedError carries retryAfterSeconds, null when unknown', () => {
  assert.equal(new RateLimitedError('x', { retryAfterSeconds: 12 }).retryAfterSeconds, 12);
  assert.equal(new RateLimitedError().retryAfterSeconds, null);
});

test('callers can discriminate between error kinds', () => {
  const err: unknown = new ApiError('nope', 500);
  assert.ok(err instanceof ApiError);
  for (const other of [
    NotFoundError,
    ValidationError,
    RateLimitedError,
    UnavailableError,
    NetworkError,
  ]) {
    assert.ok(!(err instanceof other));
  }
});
