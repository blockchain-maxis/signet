/**
 * Operator lever: revoke one address' sessions from the command line.
 *
 * Usage:
 *   pnpm --filter @signet/web run revoke:sessions -- G...ADDRESS
 *   pnpm --filter @signet/web run revoke:sessions -- --session <session id>
 *
 * This is the incident response for "one wallet is compromised" that used to
 * require `SIGNET_SESSIONS_VALID_AFTER`, i.e. signing out every user of the
 * product. It writes to the same shared store the app reads, so a running
 * deployment honours it within the revocation refresh interval — no restart,
 * no redeploy, no env change.
 *
 * Requires `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`: without a
 * shared store the write would land in this process's memory and disappear
 * with it, so the script refuses rather than reporting a revocation that never
 * reached the app.
 */
import { SESSION_TTL_MS } from '../lib/auth.ts';
import {
  REFRESH_MS,
  UpstashRevocationStore,
  revokeAddress,
  revokeSession,
  setRevocationStore,
} from '../lib/session-revocation.ts';

function usage(message: string): never {
  console.error(`${message}

  Usage:
    revoke:sessions -- <G…address>          sign out every session for an address
    revoke:sessions -- --session <sid>      sign out one session id`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 0) usage('Nothing to revoke.');

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) {
  usage(
    'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set — without the shared store this would revoke nothing the app can see.',
  );
}
setRevocationStore(new UpstashRevocationStore(url, token));

// Entries only need to outlive the longest session they could still reject.
const until = Date.now() + SESSION_TTL_MS;

if (args[0] === '--session') {
  const sid = args[1];
  if (!sid) usage('--session needs a session id.');
  await revokeSession(sid, until);
  console.log(`Revoked session ${sid}.`);
} else {
  const address = args[0];
  if (!/^[GC][A-Z2-7]{55}$/.test(address)) usage(`Not a Stellar address: ${address}`);
  await revokeAddress(address, { until });
  console.log(`Revoked every session for ${address}.`);
}

console.log(
  `Running instances honour this within ${REFRESH_MS / 1000}s (their revocation refresh interval).`,
);
