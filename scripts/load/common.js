// Shared by the load scripts (#663). k6 runs plain JS (ES modules), not Node.
//
// The #463 contract-page fixture (apps/web/e2e/fixtures/contracts.ts): the
// StrKeys are its deterministic byte-fill addresses, spelled out because k6
// has no Stellar SDK.
export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3100').replace(/\/$/, '');
export const HANDLE = 'e2e-dev';
export const OTHER_HANDLE = 'e2e-other';
export const CONTRACT_A = 'CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG';
export const CONTRACT_B = 'CCZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLEB3K';
export const WALLET_1 = 'GDQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6CZSQ';
/** Valid contract IDs nobody deployed: the negative-cache path. */
export const UNATTRIBUTED = [
  'CAYTCMJRGEYTCMJRGEYTCMJRGEYTCMJRGEYTCMJRGEYTCMJRGEYTCZZC',
  'CAZDEMRSGIZDEMRSGIZDEMRSGIZDEMRSGIZDEMRSGIZDEMRSGIZDFJRF',
  'CAZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGGJH',
];

/**
 * A synthetic client IP for each request, sent as X-Forwarded-For, so the
 * per-IP limiter sees many clients rather than one very busy one: the run
 * measures the server, not 429s. The server must run with
 * SIGNET_TRUSTED_PROXY_HOPS=1 to believe the header (apps/web/lib/security.ts,
 * clientIp).
 */
export function clientHeaders() {
  const vu = (__VU || 1) & 255;
  const iter = __ITER || 0;
  return { 'X-Forwarded-For': `10.${vu}.${(iter >> 8) & 255}.${iter & 255}` };
}

/** 20 VUs for 2 minutes; p95 under 800 ms; under 1% errors. */
export const options = {
  vus: Number(__ENV.VUS || 20),
  duration: __ENV.DURATION || '2m',
  thresholds: {
    http_req_duration: ['p(95)<800'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

/** One of items, by weight: [[weight, value], …]. */
export function pick(weighted) {
  const total = weighted.reduce((n, [w]) => n + w, 0);
  let r = Math.random() * total;
  for (const [w, v] of weighted) {
    r -= w;
    if (r < 0) return v;
  }
  return weighted[weighted.length - 1][1];
}
