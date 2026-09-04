import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeCallbackUrl } from './loopback-callback.ts';

test('accepts the loopback URLs the CLI can actually bind', () => {
  for (const ok of [
    'http://127.0.0.1:54213/callback',
    'http://localhost:8080/callback',
    'http://[::1]:9000/callback',
  ]) {
    assert.ok(safeCallbackUrl(ok), `${ok} should be accepted`);
  }
});

test('refuses anything that is not a loopback http URL', () => {
  for (const bad of [
    undefined,
    null,
    '',
    'not a url',
    'https://evil.example/steal',
    'http://evil.example/steal',
    'http://127.0.0.1.evil.example/steal',
    'javascript:alert(1)',
    'data:text/html,<script>',
    'file:///etc/passwd',
    'http://user:pass@127.0.0.1/callback',
    '//evil.example/steal',
  ]) {
    assert.equal(safeCallbackUrl(bad as string), null, `${String(bad)} should be refused`);
  }
});

test('a hostile host that merely contains 127.0.0.1 is refused', () => {
  assert.equal(safeCallbackUrl('http://127.0.0.1@evil.example/x'), null);
});
