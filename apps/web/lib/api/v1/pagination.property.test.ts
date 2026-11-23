import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { StrKey } from '@stellar/stellar-sdk';
import type { ProfileContractsDbRow } from '../../profile-contracts.ts';
import { encodeCursor, parseCursor, V1Error } from './http.ts';
import { getV1ProfileContracts, type V1ProfileContractsCursor } from './profile-contracts.ts';
import { getV1ProfileOperations } from './profile-operations.ts';

const seed = 975_968;
const options = { seed, numRuns: 100 };
const epoch = Date.UTC(2026, 9, 1);
const wallet = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const timestamps = fc.integer({ min: 0, max: 8 });
const scenarios = fc.record({
  ticks: fc.oneof(
    fc.constant<number[]>([]),
    fc.array(timestamps, { minLength: 1, maxLength: 1 }),
    fc.array(timestamps, { minLength: 2, maxLength: 24 }),
    fc.array(timestamps, { minLength: 101, maxLength: 140 }),
  ),
  limit: fc.integer({ min: 1, max: 100 }),
  inserts: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 6 }),
});

interface Scenario {
  ticks: number[];
  limit: number;
  inserts: number[];
}

const boundaryCases: [Scenario][] = [
  [{ ticks: [0, 0], limit: 1, inserts: [1] }],
  [{ ticks: Array<number>(101).fill(0), limit: 100, inserts: [2] }],
  [{ ticks: [0, 1, 1, 2], limit: 2, inserts: [1, 2] }],
];

async function walk<Cursor>(
  scenario: Scenario,
  expected: string[],
  read: (cursor: Cursor | null) => Promise<{ ids: string[]; next: string | null }>,
  insert: (id: number, tick: number) => void,
): Promise<void> {
  const { limit, ticks, inserts } = scenario;
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: Cursor | null = null;
  let id = ticks.length;
  let tick = Math.max(0, ...ticks);

  for (let page = 0; page < Math.max(1, Math.ceil(expected.length / limit)); page++) {
    const { ids, next } = await read(cursor);
    assert.ok(ids.length <= limit);
    for (const row of ids) {
      assert.ok(!seen.has(row), `page ${page + 1} repeated ${row}`);
      seen.add(row);
    }
    assert.deepEqual(ids, expected.slice(page * limit, (page + 1) * limit));
    if (next === null) {
      assert.deepEqual([...seen], expected);
      return;
    }
    assert.ok(!cursors.has(next), 'server returned a repeated cursor');
    cursors.add(next);
    cursor = parseCursor<Cursor>(next);
    assert.notEqual(cursor, null, 'a continuation cursor must decode to a payload');
    for (let n = inserts[page] ?? 0; n > 0; n--) insert(id++, ++tick);
  }
  assert.fail('expected a null cursor after the final page');
}

function contractRow(i: number, tick: number): ProfileContractsDbRow {
  const key = Buffer.alloc(32);
  key.writeUInt32BE(i, 28);
  return {
    address: StrKey.encodeContract(key),
    network: 'testnet',
    deployerPubkey: wallet,
    deployTxHash: i.toString(16).padStart(64, '0'),
    deployedAt: new Date(epoch + tick * 1000),
    wasmHash: null,
    executableType: 'wasm',
    walletId: 'w1',
    walletPubkey: wallet,
  };
}

test('contract pagination walks the original rows through timestamp ties and head inserts', async () => {
  await fc.assert(
    fc.asyncProperty(scenarios, async (scenario) => {
      const original = scenario.ticks.map((tick, i) => contractRow(i, tick));
      const rows = [...original].reverse();
      const expected = [...original]
        .sort(
          (a, b) =>
            new Date(b.deployedAt).getTime() - new Date(a.deployedAt).getTime() ||
            (a.address < b.address ? -1 : 1),
        )
        .map(({ address }) => address);
      await walk<V1ProfileContractsCursor>(
        scenario,
        expected,
        async (cursor) => {
          const { data, meta } = await getV1ProfileContracts(
            'alice',
            { cursor, limit: scenario.limit },
            {
              network: 'testnet',
              db: { listContracts: async () => ({ contracts: rows, walletCount: 1 }) },
            },
          );
          assert.equal(meta.source, 'database');
          return { ids: data.map(({ address }) => address), next: meta.nextCursor };
        },
        (i, tick) => rows.unshift(contractRow(i, tick)),
      );
    }),
    { ...options, examples: boundaryCases },
  );
});

function operationRow(i: number, tick: number) {
  return {
    id: String(i).padStart(6, '0'),
    type: 'invoke_host_function',
    createdAt: new Date(epoch + tick * 1000),
    successful: true,
  };
}

// Enable this property when #968 replaces the operations offset with a keyset cursor.
test.skip('operation pagination walks the original rows through timestamp ties and head inserts', async () => {
  await fc.assert(
    fc.asyncProperty(scenarios, async (scenario) => {
      const original = scenario.ticks.map((tick, i) => operationRow(i, tick));
      const rows = [...original];
      const expected = [...original]
        .sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || Number(b.id) - Number(a.id),
        )
        .map(({ id }) => id);
      await walk<{ offset: number }>(
        scenario,
        expected,
        async (cursor) => {
          // Exercise main's offset seam until #968 supplies the keyset seam.
          // Fulfil the requested offset against the live list on every read.
          const { data, meta } = await getV1ProfileOperations(
            'alice',
            { ...cursor, limit: scenario.limit },
            {
              getPagedOperations: async (_handle, offset, limit) => ({
                data: [...rows]
                  .sort(
                    (a, b) =>
                      b.createdAt.getTime() - a.createdAt.getTime() || (a.id > b.id ? -1 : 1),
                  )
                  .slice(offset, offset + limit),
                total: rows.length,
              }),
            },
          );
          assert.equal(meta.source, 'database');
          return { ids: data.map(({ id }) => id), next: meta.nextCursor };
        },
        (i, tick) => rows.unshift(operationRow(i, tick)),
      );
    }),
    { ...options, examples: boundaryCases },
  );
});

test('opaque cursors round-trip arbitrary JSON', () => {
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      assert.deepEqual(parseCursor(encodeCursor(value)), value);
    }),
    {
      ...options,
      examples: [
        [null],
        [false],
        [42.5],
        ['🌊 日本語'],
        [[]],
        [{}],
        [{ nested: [{ child: [true, null] }] }],
      ],
    },
  );
});

test('arbitrary cursor strings decode or throw bad_request', () => {
  const encoded = fc.jsonValue().map((value) => encodeCursor(value));
  fc.assert(
    fc.property(fc.oneof(fc.string({ unit: 'binary' }), encoded), (input) => {
      try {
        parseCursor(input);
      } catch (error) {
        assert.ok(error instanceof V1Error);
        assert.equal(error.code, 'bad_request');
      }
    }),
    options,
  );
  assert.equal(parseCursor(''), null);
  const payload = encodeCursor({ nested: [1, 2] });
  for (const malformed of [
    '@@',
    '🌊',
    payload.slice(0, 6),
    Buffer.from('\x01invalid JSON').toString('base64url'),
    encodeCursor({}, 255),
  ]) {
    assert.throws(
      () => parseCursor(malformed),
      (error: unknown) => error instanceof V1Error && error.code === 'bad_request',
    );
  }
});
