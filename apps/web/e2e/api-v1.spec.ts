import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import Ajv2020 from 'ajv/dist/2020.js';
import { LIMITS } from '../lib/rate-limit-policy.ts';
import {
  CONTRACT_A,
  CONTRACT_C,
  FIXTURE_HANDLE,
  OTHER_HANDLE,
  WALLET_1,
  WASM_HASH_1,
} from './fixtures/contracts';

/**
 * Contract tests for `/api/v1` against its own OpenAPI document (#658).
 *
 * The document is the one the server publishes (`/api/v1/openapi.json`,
 * #626), so what is checked is what integrators read. Every documented GET
 * is called against the contract-page fixture (#463), and each answer's
 * status, documented headers and body are validated against the operation's
 * schema for that status. A route under `app/api/v1` the document does not
 * describe fails the run.
 *
 * `@db`: it runs in `e2e-linked`, where the fixture database exists.
 */

// Playwright loads specs as CommonJS, so __dirname, not import.meta.
const API_DIR = join(__dirname, '../app/api/v1');
const DOC_ID = 'https://signet.test/api/v1/openapi.json';

interface Operation {
  operationId: string;
  parameters?: Array<{ name: string; in: string }>;
  responses: Record<
    string,
    {
      headers?: Record<string, unknown>;
      content?: Record<string, { schema?: Record<string, unknown> }>;
    }
  >;
}
type Doc = { paths: Record<string, { get?: Operation }> } & Record<string, unknown>;

/** Each test gets its own client IP, so no test spends another's rate-limit budget. */
let nextIp = 1;
const ipHeaders = (retry: number) => ({
  'x-vercel-forwarded-for': `198.51.${100 + retry}.${nextIp++}`,
});

let doc: Doc;
let ajv: Ajv2020;

test.beforeAll(async ({ request }) => {
  const res = await request.get('/api/v1/openapi.json');
  expect(res.status()).toBe(200);
  doc = (await res.json()) as Doc;
  ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', (s: unknown) => typeof s === 'string' && !Number.isNaN(Date.parse(s)));
  ajv.addSchema({ ...doc, $id: DOC_ID });
});

/** `$ref`s in an operation's schema, made absolute against the document. */
function qualify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(qualify);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node).map(([k, v]) => [
      k,
      k === '$ref' && typeof v === 'string' && v.startsWith('#/') ? `${DOC_ID}${v}` : qualify(v),
    ]),
  );
}

function operation(operationId: string): { path: string; op: Operation } {
  for (const [path, item] of Object.entries(doc.paths)) {
    if (item.get?.operationId === operationId) return { path, op: item.get };
  }
  throw new Error(`no operation ${operationId} in the served document`);
}

/**
 * Validates a response against what the document says for its status: the
 * status is documented, every documented header is present, and the body
 * matches the schema of its content type.
 */
async function expectDocumented(res: APIResponse, operationId: string): Promise<unknown> {
  const { op } = operation(operationId);
  const status = String(res.status());
  const def = op.responses[status];
  expect(def, `${operationId} answered ${status}, which it does not document`).toBeTruthy();
  for (const name of Object.keys(def!.headers ?? {})) {
    expect(
      res.headers()[name.toLowerCase()],
      `${operationId} ${status} lacks ${name}`,
    ).toBeTruthy();
  }
  if (!def!.content) return null;
  const type = (res.headers()['content-type'] ?? '').split(';')[0]!.trim();
  const content = def!.content[type];
  expect(
    content,
    `${operationId} ${status} answered ${type}, which it does not document`,
  ).toBeTruthy();
  if (type !== 'application/json') return res.text();
  const body = await res.json();
  const validate = ajv.compile(qualify(content!.schema) as Record<string, unknown>);
  if (!validate(body)) {
    const errors = (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`);
    throw new Error(
      `${operationId} ${status} does not match its schema:\n  ${errors.join('\n  ')}\n${JSON.stringify(body, null, 2)}`,
    );
  }
  return body;
}

/** Fills a documented path's parameters from the fixture. */
function fill(path: string): string {
  const values: Record<string, string> = {
    handle: FIXTURE_HANDLE,
    // The lookup takes an account; everything else under {address} a contract.
    address: path.startsWith('/lookup/') ? WALLET_1 : CONTRACT_A,
    wasmHash: WASM_HASH_1,
  };
  return path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values[name];
    if (!value) throw new Error(`no fixture value for {${name}} in ${path}`);
    return encodeURIComponent(value);
  });
}

const get = (request: APIRequestContext, path: string, retry: number) =>
  request.get(`/api/v1${path}`, { headers: ipHeaders(retry) });

test.describe('the /api/v1 contract @db', () => {
  test('every route under app/api/v1 is documented', () => {
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name === 'route.ts')
          routes.push(relative(API_DIR, dir).split(sep).join('/'));
      }
    };
    walk(API_DIR);
    // `[param]` in a directory and `{param}` (or `{param}.svg`) in the document
    // are both "one segment".
    const shape = (p: string) =>
      `/${p.replace(/^\/+|\/+$/g, '')}`.replace(/\[[^\]]+\]|\{[^}]+\}(\.\w+)?/g, '*');
    const documented = new Set(Object.keys(doc.paths).map(shape));
    const missing = routes.map(shape).filter((r) => !documented.has(r));
    expect(missing, 'routes the OpenAPI document does not describe').toEqual([]);
    expect(routes.length).toBeGreaterThan(5);
  });

  test('every documented GET answers as documented', async ({ request }, testInfo) => {
    const paths = Object.entries(doc.paths).filter(([, item]) => item.get);
    expect(paths.length).toBeGreaterThan(5);
    for (const [path, item] of paths) {
      const res = await get(request, fill(path), testInfo.retry);
      await expectDocumented(res, item.get!.operationId);
    }
  });

  test('an attributed contract is a 200 with its attribution', async ({ request }, testInfo) => {
    const res = await get(
      request,
      `/profiles/${FIXTURE_HANDLE}/contracts/${CONTRACT_A}`,
      testInfo.retry,
    );
    expect(res.status()).toBe(200);
    const body = (await expectDocumented(res, 'getProfileContract')) as {
      data: { address: string; attribution: { method: string; wallet: string } };
    };
    expect(body.data.address).toBe(CONTRACT_A);
    expect(body.data.attribution).toEqual({ method: 'indexer', wallet: WALLET_1 });
  });

  test('an unattributed contract is the same 404 as a missing one', async ({
    request,
  }, testInfo) => {
    const theirs = await get(
      request,
      `/profiles/${OTHER_HANDLE}/contracts/${CONTRACT_A}`,
      testInfo.retry,
    );
    // On another network: not this deployment's to attribute.
    const elsewhere = await get(
      request,
      `/profiles/${FIXTURE_HANDLE}/contracts/${CONTRACT_C}`,
      testInfo.retry,
    );
    for (const res of [theirs, elsewhere]) {
      expect(res.status()).toBe(404);
      await expectDocumented(res, 'getProfileContract');
    }
    expect(await elsewhere.text()).toBe(await theirs.text());
  });

  test('an unknown handle is a 404 where a handle must exist', async ({ request }, testInfo) => {
    for (const [path, operationId] of [
      ['/profiles/e2e-nobody-here', 'getProfile'],
      ['/profiles/e2e-nobody-here/wallets', 'getHandleWallets'],
    ] as const) {
      const res = await get(request, path, testInfo.retry);
      expect(res.status(), path).toBe(404);
      await expectDocumented(res, operationId);
    }
  });

  test('malformed parameters are a 400', async ({ request }, testInfo) => {
    for (const [path, operationId] of [
      ['/profiles/Not%20A%20Handle!', 'getProfile'],
      [`/profiles/${FIXTURE_HANDLE}/contracts?limit=0`, 'getProfileContracts'],
      [`/profiles/${FIXTURE_HANDLE}/contracts?cursor=@@`, 'getProfileContracts'],
      [`/profiles/${FIXTURE_HANDLE}/contracts/CNOTAREALCONTRACT`, 'getProfileContract'],
      [`/lookup/${CONTRACT_A}`, 'lookupWallet'],
      ['/specs/not-a-hash', 'getSpecByHash'],
    ] as const) {
      const res = await get(request, path, testInfo.retry);
      expect(res.status(), path).toBe(400);
      await expectDocumented(res, operationId);
    }
  });

  test('over the limit is a documented 429 with Retry-After', async ({ request }, testInfo) => {
    test.setTimeout(120_000);
    const headers = ipHeaders(testInfo.retry);
    // A 400 is the cheapest answer, and the limiter runs before validation.
    const path = '/api/v1/profiles/Not%20A%20Handle!';
    let limited: APIResponse | undefined;
    for (let i = 0; i <= LIMITS.v1Read && !limited; i += 15) {
      const batch = await Promise.all(
        Array.from({ length: 15 }, () => request.get(path, { headers })),
      );
      limited = batch.find((r) => r.status() === 429);
    }
    expect(limited, `no 429 after ${LIMITS.v1Read + 15} requests`).toBeTruthy();
    expect(Number(limited!.headers()['retry-after'])).toBeGreaterThan(0);
    await expectDocumented(limited!, 'getProfile');
  });
});
