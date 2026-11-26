import { test, expect } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';
import { apiSignIn } from './support';

// Session lifecycle e2e tests: logout, "sign out other devices", and revocation.
// Verifies that session revocation is enforced across real routes and browser contexts.

test('logout revokes the session id so the old cookie stops working', async ({ browser }) => {
  const kp = Keypair.random();
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();

  await apiSignIn(pageA, kp);
  await pageA.goto('/app');
  await expect(pageA.getByRole('heading', { name: 'Overview' })).toBeVisible();

  // Save the cookies before logout
  const cookies = await contextA.cookies();

  // Logout in context A
  const res = await pageA.request.post('/api/auth/logout', {
    headers: { origin: new URL(pageA.url()).origin },
  });
  expect(res.ok()).toBeTruthy();

  // In context A, the cookie was cleared; navigating to /app shows the wall
  await pageA.goto('/app');
  await expect(pageA.getByRole('button', { name: /sign in with wallet/i })).toBeVisible();
  await expect(pageA.getByRole('heading', { name: 'Overview' })).not.toBeVisible();

  // Put A's old cookie into a fresh context
  const freshContext = await browser.newContext();
  await freshContext.addCookies(cookies);
  const freshPage = await freshContext.newPage();

  // Navigating to /app with the old cookie must show the sign-in wall
  await freshPage.goto('/app');
  await expect(freshPage.getByRole('button', { name: /sign in with wallet/i })).toBeVisible();
  await expect(freshPage.getByRole('heading', { name: 'Overview' })).not.toBeVisible();

  await contextA.close();
  await freshContext.close();
});

test('"sign out other devices" from settings signs out context B and keeps context A', async ({ browser }) => {
  const kp = Keypair.random();
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();

  await apiSignIn(pageA, kp);
  await apiSignIn(pageB, kp);

  // Both contexts start with access
  await pageA.goto('/app');
  await expect(pageA.getByRole('heading', { name: 'Overview' })).toBeVisible();

  await pageB.goto('/app');
  await expect(pageB.getByRole('heading', { name: 'Overview' })).toBeVisible();

  // From page A, go to /app/settings and click "Sign out other devices"
  await pageA.goto('/app/settings');
  await expect(pageA.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

  await pageA.getByRole('button', { name: /sign out other devices/i }).click();
  await expect(pageA.getByText(/other devices signed out/i)).toBeVisible();

  // Context B's /app now shows the sign-in wall
  await pageB.goto('/app');
  await expect(pageB.getByRole('button', { name: /sign in with wallet/i })).toBeVisible();
  await expect(pageB.getByRole('heading', { name: 'Overview' })).not.toBeVisible();

  // Context A's /app still shows Overview
  await pageA.goto('/app');
  await expect(pageA.getByRole('heading', { name: 'Overview' })).toBeVisible();

  await contextA.close();
  await contextB.close();
});

test('revoking scope "all" from context A signs out both sessions', async ({ browser }) => {
  const kp = Keypair.random();
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();

  await apiSignIn(pageA, kp);
  await apiSignIn(pageB, kp);

  await pageA.goto('/app');
  await expect(pageA.getByRole('heading', { name: 'Overview' })).toBeVisible();

  await pageB.goto('/app');
  await expect(pageB.getByRole('heading', { name: 'Overview' })).toBeVisible();

  // Revoke all from context A
  const res = await pageA.request.post('/api/auth/revoke', {
    headers: { origin: new URL(pageA.url()).origin },
    data: { scope: 'all' },
  });
  expect(res.ok()).toBeTruthy();

  // Both context A and context B show the sign-in wall
  await pageA.goto('/app');
  await expect(pageA.getByRole('button', { name: /sign in with wallet/i })).toBeVisible();
  await expect(pageA.getByRole('heading', { name: 'Overview' })).not.toBeVisible();

  await pageB.goto('/app');
  await expect(pageB.getByRole('button', { name: /sign in with wallet/i })).toBeVisible();
  await expect(pageB.getByRole('heading', { name: 'Overview' })).not.toBeVisible();

  await contextA.close();
  await contextB.close();
});

test('a session for a different keypair is unaffected by revoking another address', async ({ browser }) => {
  const kpA = Keypair.random();
  const kpOther = Keypair.random();

  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  const contextOther = await browser.newContext();
  const pageOther = await contextOther.newPage();

  await apiSignIn(pageA, kpA);
  await apiSignIn(pageOther, kpOther);

  await pageA.goto('/app');
  await expect(pageA.getByRole('heading', { name: 'Overview' })).toBeVisible();

  await pageOther.goto('/app');
  await expect(pageOther.getByRole('heading', { name: 'Overview' })).toBeVisible();

  // Revoke all sessions for kpA
  const res = await pageA.request.post('/api/auth/revoke', {
    headers: { origin: new URL(pageA.url()).origin },
    data: { scope: 'all' },
  });
  expect(res.ok()).toBeTruthy();

  // Context A sees the sign-in wall
  await pageA.goto('/app');
  await expect(pageA.getByRole('button', { name: /sign in with wallet/i })).toBeVisible();
  await expect(pageA.getByRole('heading', { name: 'Overview' })).not.toBeVisible();

  // Context Other still has active session and sees Overview
  await pageOther.goto('/app');
  await expect(pageOther.getByRole('heading', { name: 'Overview' })).toBeVisible();

  await contextA.close();
  await contextOther.close();
});
