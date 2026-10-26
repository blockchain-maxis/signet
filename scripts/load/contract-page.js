// Load on the contract page (#663): Overview, Functions and Activity for the
// #463 fixture contract, and 10% unattributed addresses to exercise the
// negative cache (#458).
//
//   SIGNET_TRUSTED_PROXY_HOPS=1 pnpm --filter @signet/web start -p 3100   # fixture DB loaded
//   k6 run scripts/load/contract-page.js                                  # BASE_URL=http://localhost:3100
//
// k6 is a single binary (https://grafana.com/docs/k6/latest/set-up/install-k6/),
// an optional prerequisite; `podman run --rm -i --network host grafana/k6 run -
// < scripts/load/contract-page.js` works without installing it. Never point it
// at a shared deployment.
import http from 'k6/http';
import { check } from 'k6';
import {
  BASE_URL,
  CONTRACT_A,
  CONTRACT_B,
  HANDLE,
  UNATTRIBUTED,
  clientHeaders,
  options as common,
  pick,
} from './common.js';

export const options = {
  ...common,
  thresholds: {
    ...common.thresholds,
    'checks{kind:attributed}': ['rate>0.99'],
    'checks{kind:unattributed}': ['rate>0.99'],
  },
};

const page = (address, tab) => `${BASE_URL}/p/${HANDLE}/contract/${address}${tab ? `/${tab}` : ''}`;

export default function () {
  const headers = clientHeaders();
  const kind = pick([
    [90, 'attributed'],
    [10, 'unattributed'],
  ]);
  if (kind === 'unattributed') {
    const address = UNATTRIBUTED[Math.floor(Math.random() * UNATTRIBUTED.length)];
    // A 404 is the right answer, not a failure.
    const res = http.get(page(address), {
      headers,
      tags: { kind, name: 'contract-404' },
      responseCallback: http.expectedStatuses(404),
    });
    check(res, { 'unattributed is 404': (r) => r.status === 404 }, { kind });
    return;
  }
  const tab = pick([
    [50, ''],
    [30, 'functions'],
    [20, 'activity'],
  ]);
  const address = pick([
    [80, CONTRACT_A],
    [20, CONTRACT_B],
  ]);
  const res = http.get(page(address, tab), {
    headers,
    tags: { kind, name: `contract-${tab || 'overview'}` },
  });
  check(res, { 'page is 200': (r) => r.status === 200 }, { kind });
}
