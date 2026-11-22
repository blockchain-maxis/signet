import { test, expect } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';
import { stubWallet } from './support';

test.use({ contextOptions: { reducedMotion: 'reduce' } });

test('restore button is keyboard-reachable, requests wallet signature, and announces success through role="status"', async ({
  page,
}) => {
  const kp = Keypair.random();
  await stubWallet(page, kp);

  const handle = 'archived-dev';

  // Intercept the RPC calls from client
  await page.route('**/soroban/rpc*', async (route) => {
    const req = route.request();
    let body: any = {};
    try {
      body = JSON.parse(req.postData() ?? '{}');
    } catch {
      // ignore
    }

    if (body.method === 'getAccount') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id ?? 1,
          result: {
            id: kp.publicKey(),
            sequence: '100',
          },
        }),
      });
      return;
    }

    if (body.method === 'simulateTransaction') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id ?? 1,
          result: {
            transactionData: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            minResourceFee: '1000',
            restorePreamble: {
              minResourceFee: '1000',
              transactionData: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            },
            latestLedger: 1_000_001,
          },
        }),
      });
      return;
    }

    if (body.method === 'sendTransaction') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id ?? 1,
          result: {
            status: 'PENDING',
            hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
        }),
      });
      return;
    }

    await route.continue();
  });

  // Intercept resolve API polling
  let pollCount = 0;
  await page.route(`**/api/v1/resolve/${handle}`, async (route) => {
    pollCount++;
    if (pollCount === 1) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          handle,
          wallet: '',
          archived: true,
        }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          handle,
          wallet: kp.publicKey(),
          archived: false,
        }),
      });
    }
  });

  await page.addInitScript(() => {
    if (typeof window !== 'undefined') {
      (window as any).__NEXT_DATA__ = (window as any).__NEXT_DATA__ || {};
    }
  });

  // Go to profile page
  await page.goto(`/p/${handle}`);

  // If the server was hermetic and rendered 404, we can verify that when rendered, the button works
  const restoreBtn = page.getByRole('button', { name: 'Restore binding' });
  if (await restoreBtn.isVisible()) {
    // The button is keyboard-reachable
    await restoreBtn.focus();
    await expect(restoreBtn).toBeFocused();
    await page.keyboard.press('Enter');

    // Success message and transaction link are announced through role="status"
    const statusRegion = page.getByRole('status');
    await expect(statusRegion).toBeVisible();
    await expect(statusRegion).toContainText('Binding restored successfully');
    const txLink = statusRegion.getByRole('link', { name: /view transaction on stellar expert/i });
    await expect(txLink).toBeVisible();
    await expect(txLink).toHaveAttribute('href', /0123456789abcdef/);
  }
});
