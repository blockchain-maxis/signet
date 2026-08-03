import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCsp, generateNonce } from './csp.ts';

/** Pull a single directive (e.g. `script-src`) out of a CSP header value. */
function directive(csp: string, name: string): string {
  const found = csp.split('; ').find((d) => d.startsWith(`${name} `));
  assert.ok(found, `expected a ${name} directive`);
  return found!;
}

test('script-src is bound to the nonce and drops unsafe-inline', () => {
  const csp = buildCsp('abc123');
  const scriptSrc = directive(csp, 'script-src');
  assert.match(scriptSrc, /'nonce-abc123'/);
  assert.match(scriptSrc, /'self'/);
  assert.doesNotMatch(scriptSrc, /'unsafe-inline'/, "script-src must not allow 'unsafe-inline'");
});

test("style-src keeps 'unsafe-inline' for inline React styles", () => {
  const styleSrc = directive(buildCsp('n'), 'style-src');
  assert.match(styleSrc, /'unsafe-inline'/);
});

test("'unsafe-eval' is present only in development", () => {
  assert.doesNotMatch(directive(buildCsp('n'), 'script-src'), /'unsafe-eval'/);
  assert.doesNotMatch(directive(buildCsp('n', { dev: false }), 'script-src'), /'unsafe-eval'/);
  assert.match(directive(buildCsp('n', { dev: true }), 'script-src'), /'unsafe-eval'/);
});

test('the policy carries the expected hardening directives', () => {
  const csp = buildCsp('n');
  for (const d of [
    "default-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ]) {
    assert.ok(csp.includes(d), `expected policy to include: ${d}`);
  }
});

test('generateNonce returns a fresh value each call', () => {
  const a = generateNonce();
  const b = generateNonce();
  assert.notEqual(a, b);
  assert.ok(a.length > 0);
});
