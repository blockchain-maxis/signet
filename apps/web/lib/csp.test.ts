import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CSP_REPORT_GROUP,
  CSP_REPORT_PATH,
  buildCsp,
  buildReportingEndpoints,
  extractOrigin,
  generateNonce,
  resolveConnectSources,
  resolveFrameAncestors,
  __resetFrameAncestorsWarningForTest,
} from './csp.ts';
import { logger } from './logger.ts';

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

test('connect-src includes default Stellar and explorer origins', () => {
  const connectSrc = directive(buildCsp('n'), 'connect-src');
  assert.match(connectSrc, /'self'/);
  assert.match(connectSrc, /https:\/\/\*\.stellar\.org/);
  assert.match(connectSrc, /https:\/\/stellar\.expert/);
});

test('connect-src derives custom RPC origin from NEXT_PUBLIC_SOROBAN_RPC_URL', () => {
  const prev = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL;
  try {
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL =
      'https://custom-rpc.example.com/soroban/rpc?apikey=secret';
    const csp = buildCsp('n');
    const connectSrc = directive(csp, 'connect-src');
    assert.match(connectSrc, /https:\/\/custom-rpc\.example\.com/);
    assert.doesNotMatch(
      connectSrc,
      /soroban\/rpc/,
      'path and query must be stripped to pure origin',
    );
  } finally {
    if (prev === undefined) {
      delete process.env.NEXT_PUBLIC_SOROBAN_RPC_URL;
    } else {
      process.env.NEXT_PUBLIC_SOROBAN_RPC_URL = prev;
    }
  }
});

test('connect-src derives custom RPC origin from SOROBAN_RPC_URL', () => {
  const prev = process.env.SOROBAN_RPC_URL;
  try {
    process.env.SOROBAN_RPC_URL = 'https://soroban-node.provider.io:8443/rpc';
    const csp = buildCsp('n');
    const connectSrc = directive(csp, 'connect-src');
    assert.match(connectSrc, /https:\/\/soroban-node\.provider\.io:8443/);
  } finally {
    if (prev === undefined) {
      delete process.env.SOROBAN_RPC_URL;
    } else {
      process.env.SOROBAN_RPC_URL = prev;
    }
  }
});

test('connect-src derives custom Horizon origin from NEXT_PUBLIC_HORIZON_URL and HORIZON_URL', () => {
  const prevPublic = process.env.NEXT_PUBLIC_HORIZON_URL;
  const prevHorizon = process.env.HORIZON_URL;
  try {
    process.env.NEXT_PUBLIC_HORIZON_URL = 'https://horizon.mainnet.example.org';
    process.env.HORIZON_URL = 'http://127.0.0.1:8000/';
    const csp = buildCsp('n');
    const connectSrc = directive(csp, 'connect-src');
    assert.match(connectSrc, /https:\/\/horizon\.mainnet\.example\.org/);
    assert.match(connectSrc, /http:\/\/127\.0\.0\.1:8000/);
  } finally {
    if (prevPublic === undefined) {
      delete process.env.NEXT_PUBLIC_HORIZON_URL;
    } else {
      process.env.NEXT_PUBLIC_HORIZON_URL = prevPublic;
    }
    if (prevHorizon === undefined) {
      delete process.env.HORIZON_URL;
    } else {
      process.env.HORIZON_URL = prevHorizon;
    }
  }
});

test('connect-src handles malformed or empty env vars gracefully', () => {
  const prev = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL;
  try {
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL = 'not-a-valid-url';
    const csp = buildCsp('n');
    const connectSrc = directive(csp, 'connect-src');
    assert.match(connectSrc, /'self'/);
    assert.doesNotMatch(connectSrc, /not-a-valid-url/);
  } finally {
    if (prev === undefined) {
      delete process.env.NEXT_PUBLIC_SOROBAN_RPC_URL;
    } else {
      process.env.NEXT_PUBLIC_SOROBAN_RPC_URL = prev;
    }
  }
});

test('connect-src includes explicit connectSrc option and deduplicates origins', () => {
  const csp = buildCsp('n', {
    connectSrc: [
      'https://custom-wallet.io/api',
      'https://stellar.expert', // already in defaults
      'wss://*.walletconnect.org',
    ],
  });
  const connectSrc = directive(csp, 'connect-src');
  assert.match(connectSrc, /https:\/\/custom-wallet\.io/);
  assert.match(connectSrc, /wss:\/\/\*\.walletconnect\.org/);
  // Ensure 'https://stellar.expert' is not duplicated
  const occurrences = connectSrc.split(' ').filter((s) => s === 'https://stellar.expert').length;
  assert.equal(occurrences, 1);
});

test('extractOrigin safely parses various URL shapes and returns pure origins', () => {
  assert.equal(extractOrigin('https://example.com/api/v1?q=1#hash'), 'https://example.com');
  assert.equal(extractOrigin('http://localhost:8080/'), 'http://localhost:8080');
  assert.equal(extractOrigin('https://sub.domain.org:9000'), 'https://sub.domain.org:9000');
  assert.equal(extractOrigin(''), null);
  assert.equal(extractOrigin('   '), null);
  assert.equal(extractOrigin(undefined), null);
  assert.equal(extractOrigin(null), null);
  assert.equal(extractOrigin('invalid url'), null);
});

test('resolveConnectSources merges defaults, env, and custom sources correctly', () => {
  const sources = resolveConnectSources('https://api.thirdparty.com/v1');
  assert.ok(sources.includes("'self'"));
  assert.ok(sources.includes('https://*.stellar.org'));
  assert.ok(sources.includes('https://stellar.expert'));
  assert.ok(sources.includes('https://api.thirdparty.com'));
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
  assert.equal(
    buildReportingEndpoints('https://x.example/r'),
    `${CSP_REPORT_GROUP}="https://x.example/r"`,
  );
  assert.equal(buildReportingEndpoints(), `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`);
});

test('generateNonce returns a fresh value each call', () => {
  const a = generateNonce();
  const b = generateNonce();
  assert.notEqual(a, b);
  assert.ok(a.length > 0);
});

test('the embed path gets relaxed frame-ancestors while profile and app stay none', () => {
  const embedCsp = buildCsp('n', {
    path: '/p/aquawolf/contract/CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN/embed',
  });
  assert.equal(directive(embedCsp, 'frame-ancestors'), 'frame-ancestors *');

  const profileCsp = buildCsp('n', { path: '/p/aquawolf' });
  assert.equal(directive(profileCsp, 'frame-ancestors'), "frame-ancestors 'none'");

  const appCsp = buildCsp('n', { path: '/app' });
  assert.equal(directive(appCsp, 'frame-ancestors'), "frame-ancestors 'none'");

  const rootCsp = buildCsp('n', { path: '/' });
  assert.equal(directive(rootCsp, 'frame-ancestors'), "frame-ancestors 'none'");
});

test('frame-ancestors respects custom allowlist env var when set for embed', () => {
  const prev = process.env.FRAME_ANCESTORS_ALLOWLIST;
  try {
    process.env.FRAME_ANCESTORS_ALLOWLIST = 'https://portal.example.com https://grants.example.org';
    const embedCsp = buildCsp('n', {
      path: '/p/aquawolf/contract/CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN/embed',
    });
    assert.equal(
      directive(embedCsp, 'frame-ancestors'),
      'frame-ancestors https://portal.example.com https://grants.example.org',
    );
  } finally {
    if (prev === undefined) {
      delete process.env.FRAME_ANCESTORS_ALLOWLIST;
    } else {
      process.env.FRAME_ANCESTORS_ALLOWLIST = prev;
    }
  }
});

test('frame-ancestors allows space-separated source expressions including wildcards', () => {
  const prev = process.env.FRAME_ANCESTORS_ALLOWLIST;
  try {
    process.env.FRAME_ANCESTORS_ALLOWLIST = 'https://a.example https://*.b.example';
    const embedCsp = buildCsp('n', {
      path: '/p/aquawolf/contract/CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN/embed',
    });
    assert.equal(
      directive(embedCsp, 'frame-ancestors'),
      'frame-ancestors https://a.example https://*.b.example',
    );
  } finally {
    if (prev === undefined) {
      delete process.env.FRAME_ANCESTORS_ALLOWLIST;
    } else {
      process.env.FRAME_ANCESTORS_ALLOWLIST = prev;
    }
  }
});

test('frame-ancestors falls back to none when value contains semicolon or newline and logs once', (t) => {
  const prevAllowlist = process.env.FRAME_ANCESTORS_ALLOWLIST;
  const prevEmbed = process.env.EMBED_FRAME_ANCESTORS;
  delete process.env.EMBED_FRAME_ANCESTORS;
  __resetFrameAncestorsWarningForTest();

  const warnings: Array<{ fields: Record<string, unknown>; msg: string }> = [];
  t.mock.method(logger, 'warn', (fields: Record<string, unknown>, msg: string) => {
    warnings.push({ fields, msg });
  });

  try {
    // Semicolon injection attempt
    process.env.FRAME_ANCESTORS_ALLOWLIST = 'https://a.example; script-src https:';
    const embedPath =
      '/p/aquawolf/contract/CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN/embed';
    const cspSemi = buildCsp('n', { path: embedPath });
    assert.equal(directive(cspSemi, 'frame-ancestors'), "frame-ancestors 'none'");
    assert.equal(warnings.length, 1);
    const warning0 = warnings[0];
    assert.ok(warning0);
    assert.equal(warning0.msg, 'csp.invalidFrameAncestors');
    assert.equal(warning0.fields.value, 'https://a.example; script-src https:');

    // Repeated call with the same invalid value logs only once
    buildCsp('n', { path: embedPath });
    assert.equal(warnings.length, 1);

    // Newline injection attempt
    process.env.FRAME_ANCESTORS_ALLOWLIST = 'https://a.example\nhttps://*.b.example';
    const cspNewline = buildCsp('n', { path: embedPath });
    assert.equal(directive(cspNewline, 'frame-ancestors'), "frame-ancestors 'none'");
    assert.equal(warnings.length, 2);
    const warning1 = warnings[1];
    assert.ok(warning1);
    assert.equal(warning1.msg, 'csp.invalidFrameAncestors');
    assert.equal(warning1.fields.value, 'https://a.example\nhttps://*.b.example');
  } finally {
    if (prevAllowlist === undefined) {
      delete process.env.FRAME_ANCESTORS_ALLOWLIST;
    } else {
      process.env.FRAME_ANCESTORS_ALLOWLIST = prevAllowlist;
    }
    if (prevEmbed === undefined) {
      delete process.env.EMBED_FRAME_ANCESTORS;
    } else {
      process.env.EMBED_FRAME_ANCESTORS = prevEmbed;
    }
    __resetFrameAncestorsWarningForTest();
  }
});

test('frame-ancestors honours deprecated EMBED_FRAME_ANCESTORS alias when FRAME_ANCESTORS_ALLOWLIST is unset', () => {
  const prevAllowlist = process.env.FRAME_ANCESTORS_ALLOWLIST;
  const prevEmbed = process.env.EMBED_FRAME_ANCESTORS;
  delete process.env.FRAME_ANCESTORS_ALLOWLIST;

  try {
    process.env.EMBED_FRAME_ANCESTORS = 'https://deprecated.example.org';
    const embedCsp = buildCsp('n', {
      path: '/p/aquawolf/contract/CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN/embed',
    });
    assert.equal(
      directive(embedCsp, 'frame-ancestors'),
      'frame-ancestors https://deprecated.example.org',
    );
  } finally {
    if (prevAllowlist === undefined) {
      delete process.env.FRAME_ANCESTORS_ALLOWLIST;
    } else {
      process.env.FRAME_ANCESTORS_ALLOWLIST = prevAllowlist;
    }
    if (prevEmbed === undefined) {
      delete process.env.EMBED_FRAME_ANCESTORS;
    } else {
      process.env.EMBED_FRAME_ANCESTORS = prevEmbed;
    }
  }
});
