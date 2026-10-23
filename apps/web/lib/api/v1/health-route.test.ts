import assert from 'node:assert/strict';
import test from 'node:test';
import { GET, v1HealthData } from '../../../app/api/v1/health/route.ts';
import { ok } from './http.ts';
import { expectMatchesSchema } from './test-utils.ts';

test('GET /api/v1/health answers the schema with network identity and no-store', async () => {
  const response = await GET(new Request('http://localhost/api/v1/health'));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const body = (await response.clone().json()) as {
    data: {
      status: string;
      apiVersion: string;
      network: string;
      networkPassphrase: string;
      checks: Record<string, string>;
    };
  };
  await expectMatchesSchema(response, 'getHealth', 200);

  assert.equal(body.data.apiVersion, '1');
  // The default deployment is testnet; the passphrase names the same network.
  assert.equal(body.data.network, 'testnet');
  assert.equal(body.data.networkPassphrase, 'Test SDF Network ; September 2015');
  for (const check of ['db', 'registry', 'nonceStore', 'rateLimitStore', 'pairing']) {
    assert.ok(check in body.data.checks, `missing check: ${check}`);
  }
});

test('a degraded check still returns HTTP 200 with status "degraded"', async () => {
  const data = await v1HealthData({
    db: async () => 'up',
    registry: async () => 'down',
    nonceStore: async () => 'up',
    rateLimitStore: async () => 'up',
  });
  const response = ok(data);

  assert.equal(response.status, 200);
  await expectMatchesSchema(response, 'getHealth', 200);
  assert.equal(data.status, 'degraded');
  assert.equal(data.checks.registry, 'down');
  // Registry down means pairing cannot work, and the check says so.
  assert.equal(data.checks.pairing, 'down');
});
