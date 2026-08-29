import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FIELD_LEN, MAX_REPORTS_PER_REQUEST, parseCspReports } from './csp-report.ts';

/** A real Firefox/Safari `report-uri` payload, hyphenated field names. */
const reportUriPayload = {
  'csp-report': {
    'document-uri': 'https://signet.dev/handles',
    referrer: '',
    'violated-directive': "connect-src 'self'",
    'effective-directive': 'connect-src',
    'original-policy': "default-src 'self'; connect-src 'self'",
    disposition: 'enforce',
    'blocked-uri': 'https://horizon-testnet.stellar.org',
    'status-code': 200,
    'line-number': 42,
    'column-number': 7,
    'source-file': 'https://signet.dev/_next/static/chunk.js',
  },
};

/** A real Chromium `report-to` payload: an array of envelopes, camelCase body. */
const reportingApiPayload = [
  {
    age: 0,
    type: 'csp-violation',
    url: 'https://signet.dev/handles',
    user_agent: 'Mozilla/5.0',
    body: {
      documentURL: 'https://signet.dev/handles',
      disposition: 'enforce',
      effectiveDirective: 'connect-src',
      blockedURL: 'https://horizon-testnet.stellar.org',
      originalPolicy: "default-src 'self'",
      statusCode: 200,
      lineNumber: 42,
      columnNumber: 7,
      sourceFile: 'https://signet.dev/_next/static/chunk.js',
    },
  },
];

test('parses the report-uri dialect', () => {
  const [violation, ...rest] = parseCspReports(reportUriPayload);
  assert.equal(rest.length, 0);
  assert.deepEqual(violation, {
    documentUri: 'https://signet.dev/handles',
    violatedDirective: "connect-src 'self'",
    effectiveDirective: 'connect-src',
    blockedUri: 'https://horizon-testnet.stellar.org',
    disposition: 'enforce',
    sourceFile: 'https://signet.dev/_next/static/chunk.js',
    lineNumber: 42,
    columnNumber: 7,
  });
});

test('parses the Reporting API dialect into the same shape', () => {
  const [violation] = parseCspReports(reportingApiPayload);
  assert.ok(violation);
  assert.equal(violation.blockedUri, 'https://horizon-testnet.stellar.org');
  assert.equal(violation.documentUri, 'https://signet.dev/handles');
  // Chromium sends only `effectiveDirective`; the violated field mirrors it so
  // downstream consumers never have to special-case one engine.
  assert.equal(violation.effectiveDirective, 'connect-src');
  assert.equal(violation.violatedDirective, 'connect-src');
});

test('non-CSP entries in a Reporting API batch are ignored', () => {
  const parsed = parseCspReports([
    { type: 'deprecation', body: { id: 'x', message: 'gone' } },
    ...reportingApiPayload,
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.effectiveDirective, 'connect-src');
});

test('a bare violation body (no envelope) is accepted', () => {
  const parsed = parseCspReports({ 'violated-directive': "script-src 'self'" });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.violatedDirective, "script-src 'self'");
  // Absent fields fall back rather than landing as undefined in a log line.
  assert.equal(parsed[0]!.documentUri, 'unknown');
  assert.equal(parsed[0]!.blockedUri, 'unknown');
  assert.equal(parsed[0]!.disposition, 'enforce');
});

test('a body with no directive at all is not a violation', () => {
  assert.deepEqual(parseCspReports({ 'csp-report': { 'document-uri': 'https://signet.dev/' } }), []);
});

test('malformed payloads yield no violations instead of throwing', () => {
  for (const payload of [null, undefined, 0, 'nope', [], {}, { 'csp-report': 'nope' }, [1, 2, 3]]) {
    assert.deepEqual(parseCspReports(payload), [], `payload: ${JSON.stringify(payload)}`);
  }
});

test('wrongly-typed fields are dropped, not coerced', () => {
  const [violation] = parseCspReports({
    'csp-report': {
      'violated-directive': "img-src 'self'",
      'document-uri': { evil: true },
      'line-number': 'twelve',
      'column-number': -1,
      'source-file': '',
    },
  });
  assert.ok(violation);
  assert.equal(violation.documentUri, 'unknown');
  assert.equal(violation.lineNumber, undefined);
  assert.equal(violation.columnNumber, undefined);
  assert.equal(violation.sourceFile, undefined);
});

test('attacker-sized fields are truncated', () => {
  const [violation] = parseCspReports({
    'csp-report': {
      'violated-directive': "script-src 'self'",
      'blocked-uri': `https://evil.example/${'a'.repeat(50_000)}`,
    },
  });
  assert.ok(violation);
  assert.ok(violation.blockedUri.length <= MAX_FIELD_LEN + 1);
});

test('a flood of reports in one body is capped', () => {
  const flood = Array.from({ length: MAX_REPORTS_PER_REQUEST + 25 }, () => reportingApiPayload[0]);
  assert.equal(parseCspReports(flood).length, MAX_REPORTS_PER_REQUEST);
});
