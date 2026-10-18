import { test, expect } from '@playwright/test';
import {
  prepareSvgForPng,
  embedFontInSvg,
  IBM_PLEX_MONO_BASE64,
  PNG_EXPORT_ERROR_MESSAGE,
} from '@signet/visualiser/interactive/png';
// The registry fixture has a decodable spec; the `contracts.ts` fixtures carry views only,
// so their standalone SVG (and therefore the PNG) cannot be built.
import { REGISTRY, REGISTRY_HANDLE } from './fixtures/docs-registry';

const HAS_DB = Boolean(process.env.DATABASE_URL);

test.describe('diagram PNG export (#519)', () => {
  test('downloads PNG with dimensions 2× the SVG viewBox (in-browser export)', async ({ page }) => {
    await page.goto('/');

    const sampleViewBoxW = 720;
    const sampleViewBoxH = 480;
    const sampleSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sampleViewBoxW} ${sampleViewBoxH}" width="${sampleViewBoxW}" height="${sampleViewBoxH}">
      <style>text { font-family: monospace; font-size: 14px; }</style>
      <rect width="${sampleViewBoxW}" height="${sampleViewBoxH}" fill="#0a0908"/>
      <text x="50" y="100" fill="#f5f4ee">fn:transfer(to: Address, amount: i128) -&gt; ()</text>
    </svg>`;

    const { preparedSvg, dimensions } = prepareSvgForPng(sampleSvg, {
      theme: 'dark',
    });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(
        async ({ svgText, dims, scale, filename }) => {
          const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
          const img = new Image();

          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('Failed to load image'));
            img.src = dataUrl;
          });

          const canvas = document.createElement('canvas');
          canvas.width = Math.round(dims.width * scale);
          canvas.height = Math.round(dims.height * scale);

          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('No 2d context');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          const pngBlob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
              'image/png',
            );
          });

          const downloadUrl = URL.createObjectURL(pngBlob);
          const a = document.createElement('a');
          a.href = downloadUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        },
        {
          svgText: preparedSvg,
          dims: dimensions,
          scale: 2,
          filename: 'contract-diagram-2x.png',
        },
      ),
    ]);

    expect(download.suggestedFilename()).toBe('contract-diagram-2x.png');

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    const buffer = Buffer.concat(chunks);

    // Verify PNG header signature: 89 50 4E 47 0D 0A 1A 0A
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(buffer.subarray(0, 8)).toEqual(pngSignature);

    // PNG IHDR chunk stores width at bytes 16..20 and height at 20..24 as big-endian uint32
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);

    expect(width).toBe(sampleViewBoxW * 2);
    expect(height).toBe(sampleViewBoxH * 2);
  });

  test('embedded SVG font-face specifies IBM Plex Mono and valid base64 data', () => {
    const testSvg = '<svg viewBox="0 0 100 100"><style></style></svg>';
    const embedded = embedFontInSvg(testSvg);

    expect(embedded).toContain("font-family: 'IBM Plex Mono'");
    expect(embedded).toContain(IBM_PLEX_MONO_BASE64);
    expect(IBM_PLEX_MONO_BASE64.length).toBeGreaterThan(10000);
  });

  test('displays error message when PNG export fails on canvas error', async ({ page }) => {
    await page.goto('/');

    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <div id="container">
            <button id="fail-btn">Download PNG</button>
            <div id="error-output"></div>
          </div>
        </body>
      </html>
    `);

    await page.evaluate((errorMsg) => {
      const btn = document.getElementById('fail-btn')!;
      const errOut = document.getElementById('error-output')!;

      btn.addEventListener('click', () => {
        errOut.setAttribute('role', 'alert');
        errOut.innerHTML = `<span>${errorMsg}</span> <a href="/fallback.svg">download the SVG instead</a>`;
      });
    }, PNG_EXPORT_ERROR_MESSAGE);

    await page.click('#fail-btn');

    const alert = page.locator('#error-output[role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('PNG export failed; download the SVG instead');
  });

  test('attributed contract page diagram tab has Download PNG button and downloads at 2x viewBox @db', async ({
    page,
  }) => {
    test.skip(!HAS_DB, 'needs DATABASE_URL to render attributed contract diagram page');

    // The SVG endpoint belongs to the standalone export (#797). Serve a known SVG for it, so
    // this test covers what #519 owns (button -> canvas -> 2x PNG) and asserts against a viewBox
    // it controls.
    const viewBoxW = 720;
    const viewBoxH = 480;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBoxW} ${viewBoxH}" width="${viewBoxW}" height="${viewBoxH}"><rect width="${viewBoxW}" height="${viewBoxH}" fill="#0a0908"/><text x="24" y="48" fill="#f5f4ee" font-family="monospace" font-size="14">claim(wallet: Address)</text></svg>`;
    await page.route('**/diagram.svg*', (route) =>
      route.fulfill({ status: 200, contentType: 'image/svg+xml; charset=utf-8', body: svg }),
    );

    await page.goto(`/p/${REGISTRY_HANDLE}/contract/${REGISTRY}/diagram`);

    const pngButton = page.getByRole('button', { name: /Download PNG/i });
    await expect(pngButton).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent('download'), pngButton.click()]);

    expect(download.suggestedFilename()).toContain('.png');

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    const buffer = Buffer.concat(chunks);

    // PNG IHDR chunk stores width at bytes 16..20 and height at 20..24 as big-endian uint32.
    expect(buffer.readUInt32BE(16)).toBe(viewBoxW * 2);
    expect(buffer.readUInt32BE(20)).toBe(viewBoxH * 2);
  });
});
