import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Horizon } from '@stellar/stellar-sdk';
import {
  runOperationsWorker,
  type OperationsStore,
  type OperationCreate,
} from './operations.ts';

/**
 * An in-memory `OperationsStore` that upserts keyed on the op id — the same
 * invariant the real Prisma `Operation` table enforces. `rows.size` is the row
 * count the idempotency guarantee is about.
 */
function memoryStore(wallets: Array<{ id: string; pubkey: string }>) {
  const rows = new Map<string, OperationCreate>();
  const store: OperationsStore = {
    wallet: { findMany: async () => wallets },
    operation: {
      upsert: async ({ where, update, create }) => {
        const existing = rows.get(where.id);
        if (existing) {
          rows.set(where.id, { ...existing, ...update });
        } else {
          rows.set(where.id, create);
        }
        return undefined;
      },
    },
  };
  return { store, rows };
}

/** A Horizon stub whose operations query always returns the given fixture. */
function horizonReturning(records: unknown[]): Horizon.Server {
  const page = { records };
  return {
    operations: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            call: async () => page,
          }),
        }),
      }),
    }),
  } as unknown as Horizon.Server;
}

const WALLET = { id: 'w1', pubkey: 'GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD' };

function invokeOp(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'invoke_host_function',
    transaction_successful: true,
    source_account: WALLET.pubkey,
    created_at: '2026-03-04T12:00:00Z',
    transaction_hash: `hash-${id}`,
    function: 'HostFunctionTypeHostFunctionTypeInvokeContract',
    asset_balance_changes: [],
    ...overrides,
  };
}

test('running the worker twice over the same fixture leaves the row count unchanged', async () => {
  const fixture = [invokeOp('op-1'), invokeOp('op-2'), invokeOp('op-3')];
  const horizon = horizonReturning(fixture);
  const { store, rows } = memoryStore([WALLET]);

  const first = await runOperationsWorker(horizon, store);
  assert.equal(rows.size, 3, 'first run stores every operation');
  assert.equal(first.opsUpserted, 3);

  const second = await runOperationsWorker(horizon, store);
  assert.equal(rows.size, 3, 'second run over the same fixture adds no rows');
  assert.equal(second.opsUpserted, 3, 'the second run still upserts each op (idempotently)');
});

test('only invoke_host_function operations are stored', async () => {
  const fixture = [
    invokeOp('op-1'),
    { ...invokeOp('op-2'), type: 'payment' },
    { ...invokeOp('op-3'), type: 'create_account' },
  ];
  const { store, rows } = memoryStore([WALLET]);

  const result = await runOperationsWorker(horizonReturning(fixture), store);

  assert.equal(rows.size, 1, 'non-invocation operations are skipped');
  assert.ok(rows.has('op-1'));
  assert.equal(result.opsUpserted, 1);
});

test('re-running refreshes mutable fields without duplicating the row', async () => {
  const { store, rows } = memoryStore([WALLET]);

  await runOperationsWorker(horizonReturning([invokeOp('op-1', { transaction_successful: true })]), store);
  assert.equal(rows.get('op-1')?.successful, true);

  // Same op id, now reported as failed — should update in place, not insert.
  await runOperationsWorker(horizonReturning([invokeOp('op-1', { transaction_successful: false })]), store);
  assert.equal(rows.size, 1, 'the row count is unchanged');
  assert.equal(rows.get('op-1')?.successful, false, 'the existing row is refreshed');
});
