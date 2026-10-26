import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const ORIGIN = 'https://sdk.test';
const bundle = readFileSync(new URL('../dist/browser/signet.min.js', import.meta.url), 'utf8');

test('the browser bundle loads in a blank page and calls getHealth', async ({ page }) => {
  const asked: string[] = [];
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    asked.push(url.pathname);
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>sdk</title>' });
    }
    if (url.pathname === '/signet.min.js') {
      return route.fulfill({ contentType: 'text/javascript', body: bundle });
    }
    if (url.pathname === '/api/v1/health') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data: { status: 'ok', apiVersion: '1' } }),
      });
    }
    return route.fulfill({ status: 404, body: '' });
  });

  await page.goto(`${ORIGIN}/`);
  const health = await page.evaluate(async (origin) => {
    const { SignetClient } = await import(`${origin}/signet.min.js`);
    return new SignetClient({ baseUrl: origin }).getHealth();
  }, ORIGIN);

  expect(health).toEqual({ status: 'ok', apiVersion: '1' });
  expect(asked).toContain('/api/v1/health');
});

test('typed errors survive bundling', async ({ page }) => {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
    if (path === '/signet.min.js') {
      return route.fulfill({ contentType: 'text/javascript', body: bundle });
    }
    return route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'bad_request', message: 'Invalid handle', details: { parameter: 'handle' } },
      }),
    });
  });
  await page.goto(`${ORIGIN}/`);
  const err = await page.evaluate(async (origin) => {
    const { SignetClient, ValidationError } = await import(`${origin}/signet.min.js`);
    try {
      await new SignetClient({ baseUrl: origin }).getProfile('Bad Handle');
      return null;
    } catch (e) {
      return { validation: e instanceof ValidationError, name: (e as Error).name, parameter: (e as { parameter?: string }).parameter };
    }
  }, ORIGIN);
  expect(err).toEqual({ validation: true, name: 'ValidationError', parameter: 'handle' });
});
