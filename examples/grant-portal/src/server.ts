/**
 * A grant portal's applicant check, as a minimal Node server: GET / is the
 * form, GET /verify?handle=…&address=… asks Signet and renders the answer.
 *
 *   SIGNET_URL=http://localhost:3000 pnpm --filter grant-portal-example dev
 *
 * The Signet calls happen here, server-side, so SIGNET_API_KEY never reaches
 * a browser.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { SignetClient } from '@signet/sdk';
import { renderPage } from './page.ts';
import { verifyApplicant, type Signet } from './verify.ts';

export function handler(signet: Signet, signetUrl: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://portal.local');
    const send = (status: number, html: string) => {
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // No script on the page; images only from the Signet deployment.
        'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src ${new URL(signetUrl).origin}; form-action 'self'`,
        'x-content-type-options': 'nosniff',
      });
      res.end(html);
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    if (url.pathname === '/') {
      send(200, renderPage({ signetUrl, handle: '', address: '' }));
      return;
    }
    if (url.pathname === '/verify') {
      const handle = (url.searchParams.get('handle') ?? '').trim();
      const address = (url.searchParams.get('address') ?? '').trim();
      try {
        const result = await verifyApplicant(signet, handle.toLowerCase(), address);
        send(200, renderPage({ signetUrl, handle, address, result }));
      } catch (err) {
        console.error('verify failed', err);
        send(
          502,
          renderPage({
            signetUrl,
            handle,
            address,
            result: { kind: 'unavailable', message: 'Signet answered with an unexpected error.' },
          }),
        );
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const signetUrl = process.env.SIGNET_URL ?? 'http://localhost:3000';
  const port = Number(process.env.PORT ?? 4400);
  const signet = new SignetClient({
    baseUrl: signetUrl,
    apiKey: process.env.SIGNET_API_KEY || undefined,
  });
  createServer(handler(signet, signetUrl)).listen(port, () => {
    console.log(`grant portal on http://localhost:${port}, asking ${signetUrl}`);
  });
}
