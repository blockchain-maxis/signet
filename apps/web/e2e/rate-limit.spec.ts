import { test, expect } from '@playwright/test';

test.describe('API Rate Limiting', () => {
  test('enforces limits per bucket on the operations route', async ({ request }) => {
    const BUCKET_LIMIT = 60; // LIMITS.read

    // Use a unique fake IP to isolate this test's bucket from others
    const ip = '10.99.0.1';
    const headers = { 'x-vercel-forwarded-for': ip };

    let lastStatus = 200;
    
    // Exhaust the bucket
    for (let i = 0; i < BUCKET_LIMIT; i++) {
      const res = await request.get('/api/p/aquawolf/operations', { headers });
      lastStatus = res.status();
      // Only the last request might fail if we somehow hit a global limit, but we expect 200
      expect(res.ok()).toBeTruthy();
    }
    
    // The next request should be rate limited
    const limitedRes = await request.get('/api/p/aquawolf/operations', { headers });
    expect(limitedRes.status()).toBe(429);
    
    // Another IP should still have capacity
    const otherIpRes = await request.get('/api/p/aquawolf/operations', {
      headers: { 'x-vercel-forwarded-for': '10.99.0.2' },
    });
    expect(otherIpRes.ok()).toBeTruthy();
  });

  test('enforces limits per bucket on tRPC routes', async ({ request }) => {
    const BUCKET_LIMIT = 60; // MAX_PER_WINDOW

    const ip = '10.99.0.3';
    const headers = { 'x-vercel-forwarded-for': ip };

    for (let i = 0; i < BUCKET_LIMIT; i++) {
      const res = await request.get('/api/trpc/health', { headers });
      expect(res.ok()).toBeTruthy();
    }
    
    // The next request should be rate limited
    // trpc TOO_MANY_REQUESTS usually returns 429
    const limitedRes = await request.get('/api/trpc/health', { headers });
    expect(limitedRes.status()).toBe(429);
    
    // Another route for the SAME IP should still have capacity because buckets are per-route
    const otherRouteRes = await request.get('/api/trpc/registry.count', { headers });
    expect(otherRouteRes.ok()).toBeTruthy();
  });

  test('unknown IPs share a single UNKNOWN_IP bucket', async ({ request }) => {
    const BUCKET_LIMIT = 60; // LIMITS.read

    // No platform IP headers provided -> UNKNOWN_IP
    for (let i = 0; i < BUCKET_LIMIT; i++) {
      const res = await request.get('/api/p/somebody/operations');
      expect(res.ok()).toBeTruthy();
    }
    
    // The next request should be rate limited
    const limitedRes = await request.get('/api/p/somebody/operations');
    expect(limitedRes.status()).toBe(429);
    
    // Even if we send a completely different random header (not a trusted one), 
    // it should still hit the shared UNKNOWN_IP bucket and remain limited.
    const fakeRes = await request.get('/api/p/somebody/operations', {
      headers: { 'X-Forwarded-For': '192.168.1.1' }, // not trusted if SIGNET_TRUSTED_PROXY_HOPS is 0
    });
    expect(fakeRes.status()).toBe(429);
  });
});
