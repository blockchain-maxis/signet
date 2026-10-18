import { test, expect } from '@playwright/test';
import { CONTRACT_A, FIXTURE_HANDLE } from './fixtures/contracts';

const HAS_DB = Boolean(process.env.DATABASE_URL);

test.describe('diagram embed mode e2e', () => {
  test('headers: embed path relaxes frame-ancestors and omits X-Frame-Options', async ({
    request,
  }) => {
    const embedRes = await request.get(
      '/p/aquawolf/contract/CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN/embed',
    );
    const embedCsp = embedRes.headers()['content-security-policy'] ?? '';
    expect(embedCsp).toContain('frame-ancestors *');
    expect(embedRes.headers()['x-frame-options']).toBeUndefined();

    const profileRes = await request.get('/p/aquawolf');
    const profileCsp = profileRes.headers()['content-security-policy'] ?? '';
    expect(profileCsp).toContain("frame-ancestors 'none'");
    expect(profileRes.headers()['x-frame-options']).toBe('DENY');

    const appRes = await request.get('/app');
    const appCsp = appRes.headers()['content-security-policy'] ?? '';
    expect(appCsp).toContain("frame-ancestors 'none'");
    expect(appRes.headers()['x-frame-options']).toBe('DENY');
  });

  test('loads embed URL inside iframe from a test page and it renders, while profile is blocked', async ({
    page,
  }) => {
    const handle = HAS_DB ? FIXTURE_HANDLE : 'aquawolf';
    const address = HAS_DB
      ? CONTRACT_A
      : 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
    const embedUrl = `/p/${handle}/contract/${address}/embed`;
    const profileUrl = `/p/${handle}`;

    await page.goto('/');

    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head><title>Embed Test Container</title></head>
        <body>
          <iframe id="embed-frame" src="${embedUrl}" width="800" height="600"></iframe>
          <iframe id="profile-frame" src="${profileUrl}" width="800" height="600"></iframe>
        </body>
      </html>
    `);

    // The embed frame loads into the DOM and renders without frame-ancestors block
    const embedFrame = page.frameLocator('#embed-frame');
    if (HAS_DB) {
      await expect(embedFrame.getByText(/View on Signet/)).toBeVisible();
    } else {
      // In hermetic mode without database, it renders the 404 state within the frame
      await expect(embedFrame.getByRole('heading', { name: 'Contract not found' })).toBeVisible();
    }

    // The profile frame cannot be framed due to frame-ancestors 'none' and X-Frame-Options: DENY
    const profileFrame = page.frameLocator('#profile-frame');
    await expect(profileFrame.locator('h1')).toHaveCount(0);
  });

  test('diagram tab shows copyable iframe snippet when Embed is clicked @db', async ({ page }) => {
    test.skip(!HAS_DB, 'needs DATABASE_URL to render attributed contract page');

    await page.goto(`/p/${FIXTURE_HANDLE}/contract/${CONTRACT_A}/diagram`);

    const embedButton = page.getByRole('button', { name: 'Embed' });
    await expect(embedButton).toBeVisible();

    await embedButton.click();

    const dialog = page.getByRole('dialog', { name: 'Embed diagram code' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('code')).toContainText(
      `/p/${FIXTURE_HANDLE}/contract/${CONTRACT_A}/embed`,
    );

    const copyBtn = dialog.getByRole('button', { name: /Copy Code/i });
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();
    await expect(dialog.getByRole('button', { name: /Copied!/i })).toBeVisible();
  });
});
