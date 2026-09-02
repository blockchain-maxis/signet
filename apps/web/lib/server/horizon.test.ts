import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchHorizonOperations, HORIZON_MAX_RECORDS } from './horizon.ts';

const WALLET = 'GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG';

/** Horizon's page size — the walk only continues past a page this full. */
const PAGE_LIMIT = 200;

function record(i: number) {
  return {
    id: String(i),
    type: 'invoke_host_function',
    type_i: 24,
    function: 'HostFunctionTypeHostFunctionTypeInvokeContract',
    source_account: WALLET,
    created_at: new Date(1_700_000_000_000 + i).toISOString(),
    transaction_hash: `hash-${i}`,
    transaction_successful: true,
  };
}

/**
 * Serve `pages` pages of `size` records each, always advertising a `next` link
 * the way Horizon does. Returns a stub `fetch` plus the URLs it was asked for,
 * so a test can assert the walk stopped where it claims to have stopped.
 */
function horizonStub(pages: number[]) {
  const calls: string[] = [];
  let page = 0;
  const fetchStub = async (url: string | URL) => {
    calls.push(String(url));
    const size = pages[page] ?? 0;
    const offset = page * PAGE_LIMIT;
    page++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        _embedded: { records: Array.from({ length: size }, (_, i) => record(offset + i)) },
        _links: { next: { href: `https://horizon.example/next?cursor=${page}` } },
      }),
    } as unknown as Response;
  };
  return { fetchStub, calls };
}

async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('a history that fits under the cap is reported as complete', async () => {
  const { fetchStub, calls } = horizonStub([PAGE_LIMIT, 40]);
  const result = await withFetch(fetchStub as unknown as typeof fetch, () =>
    fetchHorizonOperations(WALLET),
  );

  assert.ok(result, 'expected a result');
  assert.equal(result!.operations.length, PAGE_LIMIT + 40);
  assert.equal(result!.truncated, false, 'a short final page means Horizon ran out');
  assert.equal(calls.length, 2);
});

test('a history that exhausts the page budget is reported as truncated', async () => {
  // Both pages come back full and Horizon still offers another: there is more
  // history than the cap lets us read, and the caller has to be told.
  const { fetchStub, calls } = horizonStub([PAGE_LIMIT, PAGE_LIMIT, PAGE_LIMIT]);
  const result = await withFetch(fetchStub as unknown as typeof fetch, () =>
    fetchHorizonOperations(WALLET),
  );

  assert.ok(result, 'expected a result');
  assert.equal(result!.truncated, true);
  assert.equal(result!.cap, HORIZON_MAX_RECORDS);
  assert.equal(result!.operations.length, HORIZON_MAX_RECORDS);
  assert.equal(calls.length, 2, 'the walk stops at the cap rather than paging on');
});

test('non-invocation operations are filtered but still count against the cap', async () => {
  const { fetchStub } = horizonStub([PAGE_LIMIT]);
  const payments = async (url: string | URL) => {
    const res = await (fetchStub as (u: string | URL) => Promise<Response>)(url);
    const page = (await res.json()) as {
      _embedded: { records: Array<{ type: string }> };
      _links: unknown;
    };
    page._embedded.records.forEach((r, i) => {
      if (i % 2 === 0) r.type = 'payment';
    });
    return { ok: true, status: 200, json: async () => page } as unknown as Response;
  };

  const result = await withFetch(payments as unknown as typeof fetch, () =>
    fetchHorizonOperations(WALLET),
  );

  assert.ok(result);
  assert.equal(result!.operations.length, PAGE_LIMIT / 2);
  assert.ok(result!.operations.every((op) => op.type === 'invoke_host_function'));
});

test('a malformed account never reaches the network', async () => {
  let called = false;
  const result = await withFetch(
    (async () => {
      called = true;
      throw new Error('should not fetch');
    }) as unknown as typeof fetch,
    () => fetchHorizonOperations('not-a-wallet'),
  );

  assert.equal(result, null);
  assert.equal(called, false);
});

test('a Horizon failure degrades to null rather than a partial record', async () => {
  const failing = async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response;
  const result = await withFetch(failing as unknown as typeof fetch, () =>
    fetchHorizonOperations(WALLET),
  );

  assert.equal(result, null);
});
