import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileRoutes, staticRoutes } from './sitemap.ts';

const now = new Date('2026-01-01T00:00:00Z');
const base = 'https://signet.test';

test('the static routes cover every public surface, including /handles', () => {
  const urls = staticRoutes(now, base).map((r) => r.url);

  assert.deepEqual(urls, [`${base}/`, `${base}/handles`, `${base}/how-it-works`, `${base}/docs`]);
});

test('/handles is listed above the secondary pages', () => {
  const routes = staticRoutes(now, base);
  const handles = routes.find((r) => r.url === `${base}/handles`);
  const docs = routes.find((r) => r.url === `${base}/docs`);

  assert.equal(handles?.priority, 0.8);
  assert.ok((handles?.priority ?? 0) > (docs?.priority ?? 0));
});

test('profiles are appended one entry per handle', () => {
  const routes = profileRoutes(['aquawolf', 'stellardev'], now, base);

  assert.deepEqual(
    routes.map((r) => r.url),
    [`${base}/p/aquawolf`, `${base}/p/stellardev`],
  );
  assert.equal(routes[0]?.lastModified, now);
});
