import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getSubdomain, resolveRewriteTarget } from './routing.ts';

// Real testnet contract (verified on-chain in contract-address.test.ts).
const CONTRACT = 'CAMYYJCHOQZSTF2KF6WY4UMFXS75VI46NEGKWE6XHWFULYD46BE5EUXZ';

// ---------------------------------------------------------------------------
// getSubdomain
// ---------------------------------------------------------------------------

test('getSubdomain extracts the handle from {handle}.signet.dev', () => {
  assert.equal(getSubdomain('alice.signet.dev'), 'alice');
  assert.equal(getSubdomain('alice.signet.dev:3000'), 'alice');
  assert.equal(getSubdomain('ALICE.signet.dev'), 'alice');
});

test('getSubdomain is null on the apex, bare localhost and Vercel previews', () => {
  assert.equal(getSubdomain('signet.dev'), null);
  assert.equal(getSubdomain('localhost'), null);
  assert.equal(getSubdomain('localhost:3000'), null);
  assert.equal(getSubdomain('my-branch-preview.vercel.app'), null);
});

test('getSubdomain supports *.localhost for local subdomain testing', () => {
  assert.equal(getSubdomain('alice.localhost'), 'alice');
  assert.equal(getSubdomain('alice.localhost:3000'), 'alice');
});

// ---------------------------------------------------------------------------
// Subdomain routing — pre-existing behaviour, pinned
// ---------------------------------------------------------------------------

test('app./docs. subdomains prefix the pathname', () => {
  assert.equal(resolveRewriteTarget('app.signet.dev', '/'), '/app');
  assert.equal(resolveRewriteTarget('app.signet.dev', '/wallets'), '/app/wallets');
  assert.equal(resolveRewriteTarget('docs.signet.dev', '/'), '/docs');
  assert.equal(resolveRewriteTarget('docs.signet.dev', '/getting-started'), '/docs/getting-started');
});

test('api. and reserved/infra subdomains pass through unchanged', () => {
  assert.equal(resolveRewriteTarget('api.signet.dev', '/api/trpc/profile.get'), null);
  assert.equal(resolveRewriteTarget('www.signet.dev', '/'), null);
  assert.equal(resolveRewriteTarget('status.signet.dev', '/'), null);
});

test('a handle subdomain root rewrites to the public profile', () => {
  assert.equal(resolveRewriteTarget('alice.signet.dev', '/'), '/p/alice');
});

test('a handle subdomain with a non-contract path passes through', () => {
  assert.equal(resolveRewriteTarget('alice.signet.dev', '/anything'), null);
  assert.equal(resolveRewriteTarget('alice.signet.dev', '/app/settings'), null);
});

// ---------------------------------------------------------------------------
// Subdomain routing — contract paths (#446)
// ---------------------------------------------------------------------------

test('{handle}.signet.dev/contract/{address} rewrites into the profile (#446)', () => {
  assert.equal(
    resolveRewriteTarget('alice.signet.dev', `/contract/${CONTRACT}`),
    `/p/alice/contract/${CONTRACT}`,
  );
});

test('{handle}.signet.dev/contract/{address}/{tab} rewrites for every real tab', () => {
  for (const tab of ['functions', 'types', 'diagram', 'run', 'activity']) {
    assert.equal(
      resolveRewriteTarget('alice.signet.dev', `/contract/${CONTRACT}/${tab}`),
      `/p/alice/contract/${CONTRACT}/${tab}`,
    );
  }
});

test('contract paths with a bad address, unknown tab or extra depth pass through', () => {
  // Not a C... StrKey.
  assert.equal(resolveRewriteTarget('alice.signet.dev', '/contract/not-an-address'), null);
  // A G... account address is not a contract.
  assert.equal(
    resolveRewriteTarget(
      'alice.signet.dev',
      '/contract/GCQZFJACBU5UII4ZDTFVVE3EPSGPOZYHMY2THOYJ57WYX6D2AQNEQINU',
    ),
    null,
  );
  // Overview is the index route (segment null), not a child segment.
  assert.equal(resolveRewriteTarget('alice.signet.dev', `/contract/${CONTRACT}/overview`), null);
  assert.equal(resolveRewriteTarget('alice.signet.dev', `/contract/${CONTRACT}/nonsense`), null);
  assert.equal(
    resolveRewriteTarget('alice.signet.dev', `/contract/${CONTRACT}/functions/extra`),
    null,
  );
  assert.equal(resolveRewriteTarget('alice.signet.dev', '/contract'), null);
});

test('a well-shaped address routes without checksum validation — the page 404s fakes', () => {
  // Routing checks only the StrKey SHAPE (C + 55 base32 chars). Full checksum
  // validation lives in contract-address.ts, which imports
  // @stellar/stellar-sdk and node:crypto — neither loads on the Edge runtime
  // this module is bundled into via the middleware. A well-shaped fake
  // rewrites here and is 404d by the contract layout's attribution check.
  const wellShapedFake = 'C' + 'A'.repeat(55);
  assert.equal(
    resolveRewriteTarget('alice.signet.dev', `/contract/${wellShapedFake}`),
    `/p/alice/contract/${wellShapedFake}`,
  );
});

// ---------------------------------------------------------------------------
// Path-based fallback — pre-existing behaviour, pinned
// ---------------------------------------------------------------------------

test('internal paths pass through on the apex', () => {
  for (const p of ['/', '/app', '/docs', '/p/alice', '/profile/alice', '/handles', '/api/trpc/x']) {
    assert.equal(resolveRewriteTarget('signet.dev', p), null);
  }
});

test('bare /link passes through — it is the CLI approval page, not a profile', () => {
  // Regression pin: `link` is a valid handle shape, so without the carve-out
  // /link?code=… would rewrite to /p/link and 404 the URL `signet link` prints.
  assert.equal(resolveRewriteTarget('signet.dev', '/link'), null);
});

test('/@{handle} rewrites to the canonical profile, lowercased', () => {
  assert.equal(resolveRewriteTarget('signet.dev', '/@alice'), '/p/alice');
  assert.equal(resolveRewriteTarget('signet.dev', '/@Alice'), '/p/alice');
});

test('/@{handle} with an invalid handle passes through', () => {
  assert.equal(resolveRewriteTarget('signet.dev', '/@no.dots'), null);
  assert.equal(resolveRewriteTarget('signet.dev', `/@${'a'.repeat(33)}`), null);
});

test('/{handle} rewrites only as a single non-reserved segment', () => {
  assert.equal(resolveRewriteTarget('signet.dev', '/alice'), '/p/alice');
  assert.equal(resolveRewriteTarget('signet.dev', '/www'), null);
  // Bare-handle paths never nest — contract docs need /@{handle} or the
  // subdomain, so an arbitrary two-segment URL can't shadow future routes.
  assert.equal(resolveRewriteTarget('signet.dev', `/alice/contract/${CONTRACT}`), null);
});

test('Vercel previews and localhost use the path-based fallback', () => {
  assert.equal(resolveRewriteTarget('my-preview.vercel.app', '/alice'), '/p/alice');
  assert.equal(resolveRewriteTarget('localhost:3000', '/@alice'), '/p/alice');
});

// ---------------------------------------------------------------------------
// Path-based fallback — contract paths (#446)
// ---------------------------------------------------------------------------

test('/@{handle}/contract/{address} rewrites into the profile (#446)', () => {
  assert.equal(
    resolveRewriteTarget('signet.dev', `/@alice/contract/${CONTRACT}`),
    `/p/alice/contract/${CONTRACT}`,
  );
});

test('/@{handle}/contract/{address}/{tab} rewrites, and works on previews', () => {
  assert.equal(
    resolveRewriteTarget('signet.dev', `/@alice/contract/${CONTRACT}/functions`),
    `/p/alice/contract/${CONTRACT}/functions`,
  );
  assert.equal(
    resolveRewriteTarget('my-preview.vercel.app', `/@alice/contract/${CONTRACT}/types`),
    `/p/alice/contract/${CONTRACT}/types`,
  );
});

test('/@{handle} contract paths reject bad addresses, unknown tabs and other suffixes', () => {
  assert.equal(resolveRewriteTarget('signet.dev', '/@alice/contract/not-an-address'), null);
  assert.equal(resolveRewriteTarget('signet.dev', `/@alice/contract/${CONTRACT}/nope`), null);
  assert.equal(resolveRewriteTarget('signet.dev', '/@alice/anything-else'), null);
});

// ---------------------------------------------------------------------------
// Edge-runtime safety
// ---------------------------------------------------------------------------

test('routing.ts never imports Node-only modules — it is bundled into the Edge middleware', () => {
  // Importing contract-address.ts (StrKey checksum validation) from here once
  // pulled @stellar/stellar-sdk and node:crypto into the middleware bundle,
  // and the Edge runtime has no native modules: every request 500d, e2e
  // caught it, and this pin keeps it caught at unit level.
  const source = readFileSync(new URL('./routing.ts', import.meta.url), 'utf8');
  // Match import statements, not prose — the file legitimately EXPLAINS the
  // constraint in a comment that names the forbidden modules.
  for (const forbidden of ["from './contract-address", "from 'node:", "from '@stellar/"]) {
    assert.ok(
      !source.includes(forbidden),
      `routing.ts must not have an import ${forbidden}… — the middleware bundles it for the Edge runtime`,
    );
  }
});
