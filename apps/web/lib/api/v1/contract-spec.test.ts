import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { beforeEach } from 'node:test';
import {
  ContractNotFound,
  NoInterface,
  RpcUnavailable,
  WasmNotFound,
  parseContractSpec,
  type ContractSpec,
} from '@signet/spec';
import {
  GET as addressGET,
  OPTIONS as addressOPTIONS,
} from '../../../app/api/v1/contracts/[address]/spec/route.ts';
import { GET as hashGET } from '../../../app/api/v1/specs/[wasmHash]/route.ts';
import { __resetRateLimit } from '../../rate-limit.ts';
import { createContractSpecApi, type ContractSpecApiDeps } from './contract-spec.ts';
import { expectMatchesSchema } from './test-utils.ts';

const ADDRESS = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const SPEC = parseContractSpec(
  readFileSync(
    new URL('../../../../../packages/spec/fixtures/identity-registry.wasm', import.meta.url),
  ),
);
const OTHER_SPEC = parseContractSpec(
  readFileSync(new URL('../../../../../packages/spec/fixtures/types_zoo.wasm', import.meta.url)),
);
const HASH = SPEC.wasmHash;
const OPTIONS = { network: 'testnet' as const, rpcUrl: 'http://127.0.0.1:1', allowHttp: true };

beforeEach(() => __resetRateLimit());

function request(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/v1/spec', {
    headers: { 'x-vercel-forwarded-for': '10.63.0.1', ...headers },
  });
}

function reader(spec: ContractSpec = SPEC, extra: ContractSpecApiDeps = {}) {
  const calls = { hash: 0, spec: 0 };
  const api = createContractSpecApi({
    options: OPTIONS,
    fetchHash: async (address, opts) => {
      calls.hash++;
      assert.equal(address, ADDRESS);
      assert.equal(opts.rpcUrl, OPTIONS.rpcUrl);
      return { type: 'wasm', wasmHash: spec.wasmHash };
    },
    fetchSpec: async (hash) => {
      calls.spec++;
      assert.equal(hash, spec.wasmHash);
      return spec;
    },
    ...extra,
  });
  return { api, calls };
}

test('address spec: public schema-validated 200 with ETag and short mapping cache', async () => {
  const { api, calls } = reader();
  const res = await api.byAddress(request(), ADDRESS);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('etag'), `"${HASH}"`);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300, s-maxage=3600');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(
    res.headers.get('access-control-expose-headers'),
    'ETag, Cache-Control, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After, Deprecation, Sunset',
  );
  assert.equal(res.headers.get('ratelimit-limit'), '60');
  const body = (await expectMatchesSchema(res, 'getContractSpec')) as {
    data: Record<string, unknown>;
  };
  assert.equal(body.data.address, ADDRESS);
  assert.equal(body.data.network, 'testnet');
  assert.equal(body.data.specSource, 'embedded');
  assert.deepEqual(calls, { hash: 1, spec: 1 });
});

test('hash spec: cold lookup uses the requested hash without an address or database', async () => {
  const { api, calls } = reader();
  const res = await api.byHash(request(), HASH.toUpperCase());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('etag'), `"${HASH}"`);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const body = (await expectMatchesSchema(res, 'getSpecByHash')) as {
    data: Record<string, unknown>;
  };
  assert.equal(body.data.wasmHash, HASH);
  assert.equal('address' in body.data, false);
  assert.deepEqual(calls, { hash: 0, spec: 1 });
});

test('conditional GET: exact, weak, list and wildcard matches return bodyless 304', async () => {
  const { api, calls } = reader();
  for (const value of [`"${HASH}"`, `W/"${HASH}"`, `"other", W/"${HASH}"`, '*']) {
    const res = await api.byAddress(request({ 'if-none-match': value }), ADDRESS);
    assert.equal(res.status, 304);
    assert.equal(await res.text(), '');
    assert.equal(res.headers.get('etag'), `"${HASH}"`);
    assert.equal(
      res.headers.get('access-control-expose-headers'),
      'ETag, Cache-Control, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After, Deprecation, Sunset',
    );
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300, s-maxage=3600');
    await expectMatchesSchema(res, 'getContractSpec');
  }
  const hashRes = await api.byHash(request({ 'if-none-match': `"${HASH}"` }), HASH);
  assert.equal(hashRes.status, 304);
  assert.match(hashRes.headers.get('cache-control')!, /immutable/);
  await expectMatchesSchema(hashRes, 'getSpecByHash');
  assert.equal(calls.spec, 1); // Address and hash endpoints share only the hash cache.
  assert.equal(calls.hash, 4); // Conditional address requests still resolve the current hash.
});

test('a nonmatching ETag returns the complete 200 response', async () => {
  const res = await reader().api.byHash(request({ 'if-none-match': '"old"' }), HASH);
  assert.equal(res.status, 200);
  await expectMatchesSchema(res, 'getSpecByHash');
});

test('concurrent requests for one hash share one bounded reader call', async () => {
  const { api, calls } = reader();
  const responses = await Promise.all([
    api.byAddress(request(), ADDRESS),
    api.byHash(request(), HASH),
    api.byHash(request(), HASH),
  ]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(calls.spec, 1);
});

test('an upgraded address resolves its new hash while the old hash stays retrievable', async () => {
  let hashCalls = 0;
  let specCalls = 0;
  const api = createContractSpecApi({
    options: OPTIONS,
    fetchHash: async () => ({ type: 'wasm', wasmHash: hashCalls++ ? OTHER_SPEC.wasmHash : HASH }),
    fetchSpec: async (hash) => {
      specCalls++;
      return hash === HASH ? SPEC : OTHER_SPEC;
    },
  });
  await api.byAddress(request(), ADDRESS);
  const upgraded = await api.byAddress(request({ 'if-none-match': `"${HASH}"` }), ADDRESS);
  assert.equal(upgraded.status, 200);
  assert.equal(upgraded.headers.get('etag'), `"${OTHER_SPEC.wasmHash}"`);
  const oldHash = await api.byHash(request(), HASH);
  assert.equal(oldHash.status, 200);
  assert.equal(oldHash.headers.get('etag'), `"${HASH}"`);
  assert.equal(hashCalls, 2);
  assert.equal(specCalls, 2);
});

test('missing contract and missing embedded spec have distinct schema-validated 404 reasons', async () => {
  const cases = [
    {
      reason: 'no_contract',
      extra: {
        fetchHash: async () => {
          throw new ContractNotFound(ADDRESS, 'testnet');
        },
      },
    },
    {
      reason: 'no_embedded_spec',
      extra: {
        fetchSpec: async () => {
          throw new NoInterface('no_section');
        },
      },
    },
    {
      reason: 'no_embedded_spec',
      extra: { fetchHash: async () => ({ type: 'stellar_asset' as const }) },
    },
  ];
  for (const { reason, extra } of cases) {
    const res = await reader(SPEC, extra).api.byAddress(request(), ADDRESS);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = (await expectMatchesSchema(res, 'getContractSpec')) as {
      error: { code: string; details: { reason: string } };
    };
    assert.equal(body.error.code, 'not_found');
    assert.equal(body.error.details.reason, reason);
  }
});

test('a missing hash has a stable 404 instead of an internal error', async () => {
  const { api } = reader(SPEC, {
    fetchSpec: async () => {
      throw new WasmNotFound(HASH, 'testnet');
    },
  });
  const res = await api.byHash(request(), HASH);
  assert.equal(res.status, 404);
  const body = (await expectMatchesSchema(res, 'getSpecByHash')) as {
    error: { details: { reason: string } };
  };
  assert.equal(body.error.details.reason, 'no_wasm');
});

test('typed RPC failure stays unavailable, is not cached, and does not leak upstream details', async () => {
  let calls = 0;
  const { api } = reader(SPEC, {
    fetchSpec: async () => {
      if (calls++ === 0)
        throw new RpcUnavailable('https://private.example/credential', new Error('secret'));
      return SPEC;
    },
  });
  const res = await api.byHash(request(), HASH);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const text = await res.clone().text();
  assert.doesNotMatch(text, /private|credential|secret/);
  await expectMatchesSchema(res, 'getSpecByHash');
  assert.equal((await api.byHash(request(), HASH)).status, 200);
  assert.equal(calls, 2);
});

test('mismatched or registry-sourced spec is never served or cached as embedded', async () => {
  for (const spec of [OTHER_SPEC, { ...SPEC, provenance: 'orbital_registry' as const }]) {
    const { api } = reader(SPEC, { fetchSpec: async () => spec });
    const res = await api.byHash(request(), HASH);
    assert.equal(res.status, spec.wasmHash === HASH ? 404 : 503);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    await expectMatchesSchema(res, 'getSpecByHash');
  }
});

test('OpenAPI validates the canonical nested SpecJson schema, not just the envelope', async () => {
  const res = await reader().api.byAddress(request(), ADDRESS);
  const body = await res.json();
  body.data.spec.functions[0].inputs = [{ name: 'bad', type: { type: 'not_a_type' } }];
  await assert.rejects(expectMatchesSchema(body, 'getContractSpec'), /did not match schema/);
});

test('actual Next route wiring rejects malformed inputs and handles preflight without any RPC', async () => {
  const address = await addressGET(request(), {
    params: Promise.resolve({ address: 'not-a-contract' }),
  });
  assert.equal(address.status, 400);
  const hash = await hashGET(request(), { params: Promise.resolve({ wasmHash: 'not-a-hash' }) });
  assert.equal(hash.status, 400);
  const preflight = await addressOPTIONS(
    new Request('http://localhost/api/v1/contracts/invalid/spec', { method: 'OPTIONS' }),
    { params: Promise.resolve({ address: 'invalid' }) },
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
});
