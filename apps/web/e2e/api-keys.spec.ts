import { test, expect, type Page } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';
import { apiSignIn } from './support';

/**
 * The dashboard's API keys (#652). Database-backed (`@db`): a key belongs to
 * a profile row, so each test seeds a profile for a fresh wallet and signs in
 * as it.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const KEY = /sgk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}/;

async function signInWithProfile(page: Page) {
  const { prisma } = await import('@signet/db');
  const owner = Keypair.random();
  await prisma.profile.create({
    data: {
      handle: `key${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 32),
      wallets: { create: [{ pubkey: owner.publicKey(), source: 'onchain', isPrimary: true }] },
    },
  });
  await prisma.$disconnect();
  await apiSignIn(page, owner);
}

async function createKey(page: Page, name: string) {
  await page.getByLabel('Key name').fill(name);
  await page.getByRole('button', { name: 'Create key' }).click();
}

test.describe('API keys in the dashboard @db', () => {
  test.skip(!HAS_DB, 'needs DATABASE_URL: keys belong to profile rows');

  test('a new key is shown once, in a dialog that holds focus', async ({ page }) => {
    await signInWithProfile(page);
    await page.goto('/app/api-keys');
    await expect(page.getByRole('heading', { level: 1, name: 'API keys' })).toBeVisible();
    await expect(page.getByText('No keys yet.')).toBeVisible();

    await createKey(page, 'grant portal');
    const dialog = page.getByRole('dialog', { name: 'Your new API key' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("You won't see this key again");
    const shown = (await dialog.getByLabel('API key', { exact: true }).textContent()) ?? '';
    expect(shown).toMatch(KEY);
    await expect(dialog.getByRole('button', { name: 'Copy API key' })).toBeFocused();

    // Tabbing never leaves the dialog for the page behind it.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const active = document.activeElement;
        const d = document.querySelector('dialog[open]');
        return !active || active === document.body || Boolean(d?.contains(active));
      });
      expect(inside, `focus left the dialog after ${i + 1} tabs`).toBe(true);
    }

    // Escape closes it and gives focus back to the trigger.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Create key' })).toBeFocused();

    // From now on only the prefix: the full key is not on the page, even after a reload.
    await page.reload();
    await expect(page.getByText('grant portal')).toBeVisible();
    await expect(page.getByText(shown.slice(0, 13) + '…')).toBeVisible();
    expect(await page.content()).not.toContain(shown);
  });

  test('revoking removes the key from the active list', async ({ page }) => {
    await signInWithProfile(page);
    await page.goto('/app/api-keys');
    await createKey(page, 'short lived');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Revoke short lived' }).click();
    await page.getByRole('button', { name: 'Confirm revoking short lived' }).click();
    await expect(page.getByText('No keys yet.')).toBeVisible();
    await page.reload();
    await expect(page.getByText('short lived')).toHaveCount(0);
  });

  test('the sixth active key is refused with a message', async ({ page }) => {
    test.setTimeout(60_000);
    await signInWithProfile(page);
    await page.goto('/app/api-keys');
    for (let i = 1; i <= 5; i++) {
      await createKey(page, `key ${i}`);
      await page.getByRole('button', { name: 'Done' }).click();
      await expect(page.getByText(`key ${i}`, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('Active keys (5 of 5)')).toBeVisible();
    await createKey(page, 'key 6');
    await expect(page.locator('#api-key-create-error')).toContainText(
      'You already have 5 active keys',
    );
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByText('key 6', { exact: true })).toHaveCount(0);
  });
});
