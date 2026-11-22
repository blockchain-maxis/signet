import { expect, test } from '@playwright/test';
import { apiSignIn } from './support';

test.describe('Settings session dates @db', () => {
  test.skip(!process.env.DATABASE_URL, 'needs DATABASE_URL for the database-backed sign-in');

  test('shows the sign-in and expiry times issued in the session cookie', async ({ page }) => {
    await apiSignIn(page);
    const cookie = (await page.context().cookies()).find(({ name }) => name === 'signet_session');
    const payload = cookie?.value.split('.')[0];
    if (!payload) throw new Error('Sign-in did not issue a session cookie payload');
    const { iat, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      iat: number;
      exp: number;
    };

    await page.goto('/app/settings');
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

    const sessionRow = page.getByText('Session', { exact: true }).locator('..');
    await expect(sessionRow).toContainText('Active · expires');
    await expect(sessionRow).toContainText(/\(in \d+ days?\)/);
    await expect(sessionRow.locator('time')).toHaveAttribute('datetime', new Date(exp).toISOString());

    const signInRow = page.getByText('Signed in', { exact: true }).locator('..');
    await expect(signInRow.locator('time')).toHaveAttribute('datetime', new Date(iat).toISOString());
  });
});
