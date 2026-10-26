// Load on the documented v1 reads (#663), against the #463 fixture.
//
//   SIGNET_TRUSTED_PROXY_HOPS=1 pnpm --filter @signet/web start -p 3100   # fixture DB loaded
//   k6 run scripts/load/api-v1.js                                         # BASE_URL=http://localhost:3100
//
// See contract-page.js for k6 itself. 404s are expected for the
// unattributed contract and are not counted as failures.
//
// The spec reads (/specs/{wasmHash}, /contracts/{address}/spec) are left out:
// they fetch from a Soroban RPC, and a load run must not drive a shared one.
// Run hermetically (SOROBAN_RPC_URL and HORIZON_URL at a dead local port) they
// would only measure a fast 503.
import http from 'k6/http';
import { check } from 'k6';
import {
  BASE_URL,
  CONTRACT_A,
  HANDLE,
  OTHER_HANDLE,
  WALLET_1,
  clientHeaders,
  options as common,
  pick,
} from './common.js';

export const options = common;

const READS = [
  [15, ['profile', `/profiles/${HANDLE}`, 200]],
  [10, ['wallets', `/profiles/${HANDLE}/wallets`, 200]],
  [15, ['contracts', `/profiles/${HANDLE}/contracts?limit=25`, 200]],
  [15, ['contract', `/profiles/${HANDLE}/contracts/${CONTRACT_A}`, 200]],
  [5, ['contract-404', `/profiles/${OTHER_HANDLE}/contracts/${CONTRACT_A}`, 404]],
  [10, ['operations', `/profiles/${HANDLE}/operations?limit=25`, 200]],
  [10, ['lookup', `/lookup/${WALLET_1}`, 200]],
  [5, ['registry-stats', '/registry/stats', 200]],
  [5, ['health', '/health', 200]],
  [5, ['badge', `/badge/${HANDLE}.svg`, 200]],
];

export default function () {
  const [name, path, want] = pick(READS);
  const res = http.get(`${BASE_URL}/api/v1${path}`, {
    headers: clientHeaders(),
    tags: { name },
    responseCallback: http.expectedStatuses(want),
  });
  check(res, {
    'expected status': (r) => r.status === want,
    'not rate limited': (r) => r.status !== 429,
  });
}
