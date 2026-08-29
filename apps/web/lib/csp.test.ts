import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CSP_REPORT_GROUP,
  CSP_REPORT_PATH,
  buildCsp,
  buildReportingEndpoints,
  generateNonce,
} from './csp.ts';

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

test('the policy reports violations through both report-uri and report-to', () => {
  const csp = buildCsp('n');
  assert.equal(directive(csp, 'report-uri'), `report-uri ${CSP_REPORT_PATH}`);
  assert.equal(directive(csp, 'report-to'), `report-to ${CSP_REPORT_GROUP}`);
});

test('an explicit report target overrides the default collector', () => {
  const csp = buildCsp('n', { reportUri: 'https://collector.example/csp' });
  assert.equal(directive(csp, 'report-uri'), 'report-uri https://collector.example/csp');
  // The group name is header-bound, not URL-bound, so it never changes.
  assert.equal(directive(csp, 'report-to'), `report-to ${CSP_REPORT_GROUP}`);
});

test('an empty report target builds a policy with no reporting directives', () => {
  const csp = buildCsp('n', { reportUri: '' });
  assert.doesNotMatch(csp, /report-uri/);
  assert.doesNotMatch(csp, /report-to/);
});

test('the Reporting-Endpoints value quotes the URL under the policy group', () => {
  assert.equal(buildReportingEndpoints('https://x.example/r'), `${CSP_REPORT_GROUP}="https://x.example/r"`);
  assert.equal(buildReportingEndpoints(), `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`);
});

test('generateNonce returns a fresh value each call', () => {
  const a = generateNonce();
  const b = generateNonce();
  assert.notEqual(a, b);
  assert.ok(a.length > 0);
});
