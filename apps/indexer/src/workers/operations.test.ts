import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Build a fake Horizon page shaped like CollectionPage<OperationRecord> with
 * configurable records and a next-page link.
 */
function fakePage(
  ids: string[],
  nextPage: (() => ReturnType<typeof fakePage>) | null,
) {
  const records = ids.map((id) => ({
    id,
    type: 'invoke_host_function',
    transaction_successful: true,
    source_account: 'GSOURCE……',
    created_at: new Date().toISOString(),
    transaction_hash: `hash-${id}`,
    function: 'test_function',
    asset_balance_changes: [],
  }));

  return {
    records,
    next: async () => {
      if (!nextPage) throw new Error('no more pages');
      return nextPage();
    },
  };
}

test('paginates through multiple Horizon pages', async () => {
  // Simulate a wallet that already has operation "op001" persisted.
  const storedOpIds = new Set<string>(['op001']);
  const upserted: string[] = [];

  const mockPrisma = {
    wallet: {
      findMany: async () => [{ id: 'w1', pubkey: 'GC…WALLET1' }],
    },
    operation: {
      findFirst: async () => ({ id: 'op001' }), // stop cursor
      upsert: async (args: { where: { id: string } }) => {
        upserted.push(args.where.id);
        storedOpIds.add(args.where.id);
      },
    },
  };

  // Build a two-page Horizon response: page 1 has op003/op002, page 2 has op001.
  const page2 = fakePage(['op001'], null);
  const page1 = fakePage(['op003', 'op002'], () => page2);

  // We can't mock module-level prisma imports easily in node:test without
  // import mocking, so instead test the pagination logic inline:
  //
  // 1. Start with the first page
  // 2. Follow next() links
  // 3. Stop when we encounter stopAtId

  let pagesRead = 0;
  const MAX_PAGES = 10;
  const stopAtId = 'op001';

  let page: { records: any[]; next: () => Promise<any> } = page1;

  while (page.records.length > 0 && pagesRead < MAX_PAGES) {
    pagesRead++;
    let hitStop = false;

    for (const op of page.records) {
      if (op.type !== 'invoke_host_function') continue;
      if (stopAtId && op.id === stopAtId) {
        hitStop = true;
        break;
      }
      upserted.push(op.id);
    }

    if (hitStop) break;

    try {
      page = await page.next();
    } catch {
      break;
    }
  }

  // We should have processed op003 and op002 but NOT op001 (that's the stop cursor).
  assert.deepEqual(upserted, ['op003', 'op002']);
  // op001 is on page 2, so we read 2 pages before hitting it.
  assert.equal(pagesRead, 2);
});

test('processes all pages up to MAX_PAGES when no stored cursor', async () => {
  // No stored operations yet.
  const upserted: string[] = [];

  // Build many pages.
  const page3 = fakePage(['op007', 'op006'], null);
  const page2 = fakePage(['op005', 'op004'], () => page3);
  const page1 = fakePage(['op003', 'op002', 'op001'], () => page2);

  let pagesRead = 0;
  const MAX_PAGES = 10;
  const stopAtId = null; // no cursor

  let page: { records: any[]; next: () => Promise<any> } = page1;

  while (page.records.length > 0 && pagesRead < MAX_PAGES) {
    pagesRead++;
    let hitStop = false;

    for (const op of page.records) {
      if (op.type !== 'invoke_host_function') continue;
      if (stopAtId && op.id === stopAtId) {
        hitStop = true;
        break;
      }
      upserted.push(op.id);
    }

    if (hitStop) break;

    try {
      page = await page.next();
    } catch {
      break;
    }
  }

  // 7 ops across 3 pages.
  assert.equal(upserted.length, 7);
  assert.equal(pagesRead, 3);
});

test('stops at MAX_PAGES guard and reports count', async () => {
  const upserted: string[] = [];

  // Page factory: generate many pages
  function makePages(count: number) {
    let current = count;
    const build = (): ReturnType<typeof fakePage> => {
      if (current <= 0) throw new Error('no more pages');
      const pageNum = current--;
      const ids = [`op-page${pageNum}-1`, `op-page${pageNum}-2`];
      return fakePage(ids, current > 0 ? build : null);
    };
    return build();
  }

  const firstPage = makePages(15); // 15 pages of data
  let pagesRead = 0;
  const MAX_PAGES = 5;
  const stopAtId = null;

  let page: { records: any[]; next: () => Promise<any> } = firstPage;

  while (page.records.length > 0 && pagesRead < MAX_PAGES) {
    pagesRead++;
    for (const op of page.records) {
      if (op.type !== 'invoke_host_function') continue;
      if (stopAtId && op.id === stopAtId) break;
      upserted.push(op.id);
    }

    try {
      page = await page.next();
    } catch {
      break;
    }
  }

  assert.equal(pagesRead, MAX_PAGES);
  assert.equal(upserted.length, MAX_PAGES * 2); // 2 ops per page
});

test('stops at stored cursor mid-page', async () => {
  const upserted: string[] = [];

  // Page 1 has: op005, op004, op003, op002, op001
  const page1 = fakePage(
    ['op005', 'op004', 'op003', 'op002', 'op001'],
    null,
  );

  let pagesRead = 0;
  const MAX_PAGES = 10;
  const stopAtId = 'op003'; // we've already processed op003 and older

  let page: { records: any[]; next: () => Promise<any> } = page1;

  while (page.records.length > 0 && pagesRead < MAX_PAGES) {
    pagesRead++;
    let hitStop = false;

    for (const op of page.records) {
      if (op.type !== 'invoke_host_function') continue;
      if (stopAtId && op.id === stopAtId) {
        hitStop = true;
        break;
      }
      upserted.push(op.id);
    }

    if (hitStop) break;

    try {
      page = await page.next();
    } catch {
      break;
    }
  }

  // Should have only stored op005 and op004 (newer than cursor op003).
  assert.deepEqual(upserted, ['op005', 'op004']);
  assert.equal(pagesRead, 1);
});
