import { test, expect, type Page } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';
import { stubWallet } from './support';

// The claim form: validation and error states. Opening it needs a connected
// wallet (the form only renders with an address), so each test stubs the
// wallet; none of them needs a session or a signature — validation runs
// client-side, and the submit path errors before any signing happens.

async function openClaimForm(page: Page): Promise<void> {
  await stubWallet(page, Keypair.random());
  await page.goto('/');
  // With a wallet connected the closing CTA reads "Claim your handle" and
  // opens the inline form (multiple ConnectWallet instances render; any works).
  await page
    .getByRole('button', { name: /claim your handle/i })
    .first()
    .click();
  await expect(page.getByPlaceholder('your-handle')).toBeVisible();
}

test('the claim form validates the handle as you type', async ({ page }) => {
  await openClaimForm(page);
  const input = page.getByPlaceholder('your-handle');
  const claim = page.getByRole('button', { name: 'Claim', exact: true });

  // Empty: nothing to submit.
  await expect(claim).toBeDisabled();

  // Wrong charset — named plainly, and the submit stays locked.
  await input.fill('Not A Handle!');
  await expect(
    page.getByText('Handle can only contain lowercase letters, numbers, underscores, and hyphens'),
  ).toBeVisible();
  await expect(claim).toBeDisabled();

  // Cleared after typing: "required" replaces the charset error.
  await input.fill('');
  await expect(page.getByText('Handle is required')).toBeVisible();

  // Reserved names are caught client-side — the contract would reject them
  // anyway, but only after costing a fee.
  await input.fill('admin');
  await expect(page.getByText('That handle is reserved for a Signet route')).toBeVisible();
  await expect(claim).toBeDisabled();

  // A valid handle clears the error and unlocks the submit.
  await input.fill('e2e-tester');
  await expect(page.getByText('Handle is required')).toHaveCount(0);
  await expect(claim).toBeEnabled();
});

test('submitting while the registry is unconfigured says so, without claiming the contract does not exist', async ({
  page,
}) => {
  // The CI e2e build ships without NEXT_PUBLIC_IDENTITY_REGISTRY_ID, so the
  // claim path must fail up front with the "coming soon" status — not a broken
  // button, not a thrown error, and no wallet signing attempted. The message
  // renders only when the BUILD baked no registry id, so skip when this
  // environment has one (a dev box with the testnet registry in .env.local;
  // CI the day a registry id is configured). Best-effort heuristic: the runner env
  // can diverge from what the build baked — a loud failure here then means
  // "your build and shell disagree about the registry", which is worth hearing.
  test.skip(
    !!process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID,
    'registry configured — the unconfigured state cannot render',
  );
  await openClaimForm(page);
  await page.getByPlaceholder('your-handle').fill('e2e-tester');
  await page.getByRole('button', { name: 'Claim', exact: true }).click();

  await expect(page.getByRole('status')).toContainText(
    'On-chain claim is unavailable — this deployment is not configured against an Identity Registry contract.',
  );
});

test('escape abandons the claim form', async ({ page }) => {
  await openClaimForm(page);
  const input = page.getByPlaceholder('your-handle');
  await input.fill('half-typed');
  await input.press('Escape');

  await expect(page.getByPlaceholder('your-handle')).toHaveCount(0);
  // Back to the CTA, ready to reopen.
  await expect(page.getByRole('button', { name: /claim your handle/i }).first()).toBeVisible();
});
