import { getNetworkPassphrase, getServerKeypair, Sep10ConfigError } from '@/lib/sep10';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
}

/**
 * SEP-1 (stellar.toml) — the discovery document SEP-10 clients read to find
 * `WEB_AUTH_ENDPOINT` and `SIGNING_KEY` before ever calling `/api/auth/sep10`.
 * Without this, the challenge/verify endpoint exists but nothing outside this
 * app knows it's there.
 */
export async function GET() {
  let signingKey: string;
  try {
    signingKey = getServerKeypair().publicKey();
  } catch (err) {
    if (err instanceof Sep10ConfigError) {
      logger.error({ err: err.message }, 'sep10.misconfigured');
      return new Response(`# ${err.message}\n`, {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    throw err;
  }

  const toml = [
    `NETWORK_PASSPHRASE="${getNetworkPassphrase()}"`,
    `WEB_AUTH_ENDPOINT="${appUrl()}/api/auth/sep10"`,
    `SIGNING_KEY="${signingKey}"`,
    `ACCOUNTS=["${signingKey}"]`,
  ].join('\n');

  return new Response(toml + '\n', {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}
