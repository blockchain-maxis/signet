import { test } from 'node:test';
import assert from 'node:assert/strict';
import sitemap from '../app/sitemap.ts';

test('sitemap includes static routes and /handles directory', async () => {
  const routes = await sitemap();
  const urls = routes.map((r) => r.url);

  assert.ok(urls.some((u) => u.endsWith('/')), 'sitemap should include root URL');
  assert.ok(urls.some((u) => u.endsWith('/handles')), 'sitemap should include /handles URL');
  assert.ok(urls.some((u) => u.endsWith('/how-it-works')), 'sitemap should include /how-it-works URL');
  assert.ok(urls.some((u) => u.endsWith('/docs')), 'sitemap should include /docs URL');

  const handlesEntry = routes.find((r) => r.url.endsWith('/handles'));
  assert.equal(handlesEntry?.priority, 0.8);
});
