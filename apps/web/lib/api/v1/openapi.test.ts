import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { GET, OPTIONS } from '../../../app/api/v1/openapi.json/route.ts';
import { getOpenApiDocument, schemas } from './openapi.ts';
import { expectMatchesSchema } from './test-utils.ts';

test('OpenAPI document structure complies with OpenAPI 3.1.0', () => {
  const doc = getOpenApiDocument();

  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.info.title, 'Signet API');
  assert.equal(doc.info.version, '1.0.0');
  assert.ok(doc.info.description.length > 0);
  assert.equal(doc.info.license?.name, 'Apache-2.0');

  assert.ok(Array.isArray(doc.servers));
  assert.ok(doc.servers.some((s) => s.url === '/api/v1'));

  assert.ok(doc.paths['/openapi.json']);
  assert.equal(doc.paths['/openapi.json']?.get?.operationId, 'getOpenApiDocument');

  // Verify core components.schemas
  const expectedSchemas = [
    'Error',
    'ErrorEnvelope',
    'PageMeta',
    'Wallet',
    'Contract',
    'Operation',
    'Profile',
    'SuccessEnvelope',
  ];

  for (const name of expectedSchemas) {
    assert.ok(doc.components.schemas[name], `Missing schema: ${name}`);
  }
});

test('all component schemas are valid JSON Schema draft 2020-12', () => {
  const ajv = new Ajv2020({ strict: false });
  ajv.addFormat('date-time', (str: unknown) => typeof str === 'string' && !isNaN(Date.parse(str)));

  for (const [name, schema] of Object.entries(schemas)) {
    const isValid = ajv.validateSchema(schema);
    assert.equal(
      isValid,
      true,
      `Schema ${name} is not valid JSON Schema 2020-12: ${JSON.stringify(ajv.errors)}`,
    );
  }
});

test('schema validation: Error and ErrorEnvelope enforce closed error codes', () => {
  const ajv = new Ajv2020({ strict: false });
  const doc = getOpenApiDocument();
  ajv.addSchema({ ...doc, $id: 'https://signet.local/openapi.json' });

  const validateError = ajv.getSchema('https://signet.local/openapi.json#/components/schemas/Error');
  assert.ok(validateError);

  // Valid error
  assert.equal(
    validateError({
      code: 'not_found',
      message: 'Handle not found',
      details: { handle: 'alice' },
    }),
    true,
  );

  // Invalid error code
  assert.equal(
    validateError({
      code: 'unsupported_code',
      message: 'Some error',
    }),
    false,
  );

  // Missing message
  assert.equal(
    validateError({
      code: 'bad_request',
    }),
    false,
  );

  // ErrorEnvelope
  const validateEnvelope = ajv.getSchema(
    'https://signet.local/openapi.json#/components/schemas/ErrorEnvelope',
  );
  assert.ok(validateEnvelope);
  assert.equal(
    validateEnvelope({
      error: {
        code: 'rate_limited',
        message: 'Too many requests',
      },
    }),
    true,
  );
  assert.equal(
    validateEnvelope({
      error: {
        code: 'bad_code',
        message: 'Invalid',
      },
    }),
    false,
  );
});

test('schema validation: Wallet address and provenance', () => {
  const ajv = new Ajv2020({ strict: false });
  ajv.addFormat('date-time', (str: unknown) => typeof str === 'string' && !isNaN(Date.parse(str)));
  const doc = getOpenApiDocument();
  ajv.addSchema({ ...doc, $id: 'https://signet.local/openapi.json' });

  const validateWallet = ajv.getSchema(
    'https://signet.local/openapi.json#/components/schemas/Wallet',
  );
  assert.ok(validateWallet);

  // Valid G address
  assert.equal(
    validateWallet({
      address: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      primary: true,
      source: 'cli_link',
      attestedAt: '2026-10-17T12:00:00.000Z',
    }),
    true,
  );

  // Valid C address
  assert.equal(
    validateWallet({
      address: 'CA3D5KRYMCMCZVACBBQINPBVYQ4WY2OA36IC3PIGGEJNVMGT4DXFV3A6',
      primary: false,
      source: 'curated',
      attestedAt: null,
      indexingPending: false,
    }),
    true,
  );

  // Invalid address pattern
  assert.equal(
    validateWallet({
      address: 'not-a-stellar-address',
      primary: false,
      source: 'none',
      attestedAt: null,
    }),
    false,
  );
});

test('schema validation: Contract and attribution', () => {
  const ajv = new Ajv2020({ strict: false });
  ajv.addFormat('date-time', (str: unknown) => typeof str === 'string' && !isNaN(Date.parse(str)));
  const doc = getOpenApiDocument();
  ajv.addSchema({ ...doc, $id: 'https://signet.local/openapi.json' });

  const validateContract = ajv.getSchema(
    'https://signet.local/openapi.json#/components/schemas/Contract',
  );
  assert.ok(validateContract);

  // Valid contract
  assert.equal(
    validateContract({
      address: 'CA3D5KRYMCMCZVACBBQINPBVYQ4WY2OA36IC3PIGGEJNVMGT4DXFV3A6',
      network: 'testnet',
      handle: 'alice',
      wasmHash: 'a'.repeat(64),
      name: 'Token',
      deployedAt: '2026-10-01T00:00:00.000Z',
      deployer: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      attribution: {
        method: 'indexer',
        wallet: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      },
    }),
    true,
  );

  // Invalid network
  assert.equal(
    validateContract({
      address: 'CA3D5KRYMCMCZVACBBQINPBVYQ4WY2OA36IC3PIGGEJNVMGT4DXFV3A6',
      network: 'futurenet',
      handle: null,
    }),
    false,
  );
});

test('schema validation: Operation and PageMeta', () => {
  const ajv = new Ajv2020({ strict: false });
  ajv.addFormat('date-time', (str: unknown) => typeof str === 'string' && !isNaN(Date.parse(str)));
  const doc = getOpenApiDocument();
  ajv.addSchema({ ...doc, $id: 'https://signet.local/openapi.json' });

  const validateOperation = ajv.getSchema(
    'https://signet.local/openapi.json#/components/schemas/Operation',
  );
  assert.ok(validateOperation);

  assert.equal(
    validateOperation({
      id: 'op-1',
      type: 'invoke_host_function',
      function: 'transfer',
      contract: 'CA3D5KRYMCMCZVACBBQINPBVYQ4WY2OA36IC3PIGGEJNVMGT4DXFV3A6',
      sourceAccount: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      createdAt: '2026-10-17T12:00:00.000Z',
      txHash: 'b'.repeat(64),
      successful: true,
    }),
    true,
  );

  const validatePageMeta = ajv.getSchema(
    'https://signet.local/openapi.json#/components/schemas/PageMeta',
  );
  assert.ok(validatePageMeta);

  assert.equal(
    validatePageMeta({
      network: 'testnet',
      source: 'database',
      nextCursor: 'eyJvIjoxMH0',
      truncated: false,
      cap: null,
      total: 42,
    }),
    true,
  );
});

test('schema validation: Profile', () => {
  const ajv = new Ajv2020({ strict: false });
  ajv.addFormat('date-time', (str: unknown) => typeof str === 'string' && !isNaN(Date.parse(str)));
  const doc = getOpenApiDocument();
  ajv.addSchema({ ...doc, $id: 'https://signet.local/openapi.json' });

  const validateProfile = ajv.getSchema(
    'https://signet.local/openapi.json#/components/schemas/Profile',
  );
  assert.ok(validateProfile);

  assert.equal(
    validateProfile({
      handle: 'alice',
      displayName: 'Alice Smith',
      bio: 'Smart contract developer',
      avatarUrl: null,
      primaryWallet: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      wallets: [
        {
          address: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
          primary: true,
          source: 'cli_link',
          attestedAt: '2026-10-17T12:00:00.000Z',
        },
      ],
      joinedAt: '2026-09-01T10:00:00.000Z',
      network: 'testnet',
      archived: false,
      counts: {
        contracts: 3,
        wallets: 1,
        invocations: 120,
      },
      countsAreLowerBounds: false,
    }),
    true,
  );
});

test('expectMatchesSchema validates real endpoint output and rejects mismatches', async () => {
  const req = new Request('http://localhost:3000/api/v1/openapi.json');
  const res = await GET(req);

  // Real route response against OpenAPI schema
  const body = await expectMatchesSchema(res, 'getOpenApiDocument');
  assert.ok(body && typeof body === 'object');
  assert.equal((body as { openapi: string }).openapi, '3.1.0');

  // Plain object support
  await expectMatchesSchema({ openapi: '3.1.0' }, 'getOpenApiDocument', 200);

  // Unknown operation throws
  await assert.rejects(
    async () => {
      await expectMatchesSchema(res, 'nonexistentOperation');
    },
    { message: /Operation "nonexistentOperation" not found/ },
  );

  // Undefined status throws
  await assert.rejects(
    async () => {
      await expectMatchesSchema(res, 'getOpenApiDocument', 418);
    },
    { message: /No response definition found for status 418/ },
  );
});

test('route /api/v1/openapi.json handles GET, OPTIONS, and mutating methods correctly', async () => {
  // GET returns 200 with OpenAPI document and proper headers
  const getReq = new Request('http://localhost:3000/api/v1/openapi.json', { method: 'GET' });
  const getRes = await GET(getReq);

  assert.equal(getRes.status, 200);
  assert.equal(getRes.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(getRes.headers.get('Cache-Control'), 'public, max-age=300');
  assert.equal(getRes.headers.get('Access-Control-Allow-Origin'), '*');
  assert.ok(getRes.headers.get('RateLimit-Limit'));

  const parsed = (await getRes.json()) as { openapi: string };
  assert.equal(parsed.openapi, '3.1.0');

  // OPTIONS returns 204 preflight
  const optReq = new Request('http://localhost:3000/api/v1/openapi.json', { method: 'OPTIONS' });
  const optRes = await OPTIONS(optReq);

  assert.equal(optRes.status, 204);
  assert.equal(optRes.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(optRes.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD, OPTIONS');

  // Mutating method POST returns 405 Method Not Allowed
  const postReq = new Request('http://localhost:3000/api/v1/openapi.json', { method: 'POST' });
  const postRes = await GET(postReq);

  assert.equal(postRes.status, 405);
  assert.equal(postRes.headers.get('Allow'), 'GET, HEAD, OPTIONS');
});
