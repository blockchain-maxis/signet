import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { handler } from './server.ts';
import type { Signet } from './verify.ts';

const SIGNET_URL = 'https://signet.example';

function defaultFake(overrides: Partial<Signet> = {}): Signet {
  return {
    getProfile: async () => null,
    getWallets: async () => [],
    listContracts: async () => ({
      data: [],
      meta: { nextCursor: null, total: 0, truncated: false, cap: null, source: 'database' },
    }),
    verifyDeployment: async () => ({ verified: false }),
    ...overrides,
  };
}

async function startServer(signet: Signet = defaultFake()) {
  const server = createServer(handler(signet, SIGNET_URL));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

test('GET / is 200, and its CSP contains img-src https://signet.example and default-src \'none\'', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.ok(
      csp.includes('img-src https://signet.example'),
      'CSP should contain img-src https://signet.example',
    );
    assert.ok(csp.includes("default-src 'none'"), 'CSP should contain default-src \'none\'');
  } finally {
    await close();
  }
});

test('POST / is 405 with allow: GET, HEAD', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/`, { method: 'POST' });
    assert.equal(res.status, 405);
    const allow = res.headers.get('allow');
    assert.equal(allow, 'GET, HEAD');
  } finally {
    await close();
  }
});

test('GET /nope is 404', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/nope`);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('GET /verify?handle=Alice&address=C… passes alice to the fake', async () => {
  let seenHandle: string | null = null;
  const fake = defaultFake({
    getProfile: async (handle) => {
      seenHandle = handle;
      return null;
    },
    verifyDeployment: async (handle) => {
      seenHandle = handle;
      return { verified: false };
    },
  });
  const { baseUrl, close } = await startServer(fake);
  try {
    const address = 'CA3D5KRYMCMCZVACBBQINPBVYQ4WY2OA36IC3PIGGEJNVMGT4DXFV3A6';
    const res = await fetch(`${baseUrl}/verify?handle=Alice&address=${address}`);
    assert.equal(res.status, 200);
    assert.equal(seenHandle, 'alice');
  } finally {
    await close();
  }
});

test('a fake that throws new Error(\'boom\') produces 502, and the body contains "unexpected error" but not "boom"', async () => {
  const fake = defaultFake({
    getProfile: async () => {
      throw new Error('boom');
    },
  });
  const { baseUrl, close } = await startServer(fake);
  try {
    const originalError = console.error;
    console.error = () => {};
    let text = '';
    let status = 0;
    try {
      const res = await fetch(`${baseUrl}/verify?handle=alice&address=C123`);
      status = res.status;
      text = await res.text();
    } finally {
      console.error = originalError;
    }
    assert.equal(status, 502);
    assert.ok(text.includes('unexpected error'), 'body should contain "unexpected error"');
    assert.ok(!text.includes('boom'), 'body should not contain "boom"');
  } finally {
    await close();
  }
});

test('HEAD / returns no body', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, '');
  } finally {
    await close();
  }
});
