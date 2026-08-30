import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nativeToScVal,
  scValToNative,
  type Operation,
  type Transaction,
} from '@stellar/stellar-sdk';
import { reduceBindings, listDirectory, isRegistryConfigured } from './directory.ts';
import type { SimulatingServer } from './server/registry-read.ts';

// Structurally valid, never deployed — every test injects a stub server rather
// than reaching an RPC endpoint.
const CONTRACT_ID = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';
const WALLET = 'GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG';

/**
 * A stub registry: answers `resolve(handle)` from `bound` and `count()` with
 * `count`, so a test can describe exactly which handles the chain considers
 * bound and check that nothing else is presented as one.
 */
function registryStub(bound: Record<string, string>, count: number): SimulatingServer {
  return {
    async simulateTransaction(tx: Transaction) {
      const op = tx.operations[0] as Operation.InvokeHostFunction;
      const invoke = op.func.invokeContract();
      const fn = invoke.functionName().toString();

      if (fn === 'count') {
        return { result: { retval: nativeToScVal(count, { type: 'u32' }) } };
      }
      if (fn === 'resolve') {
        const handle = scValToNative(invoke.args()[0]!) as string;
        const wallet = bound[handle];
        return {
          result: {
            retval: wallet ? nativeToScVal(wallet, { type: 'address' }) : nativeToScVal(null),
          },
        };
      }
      return { result: { retval: nativeToScVal(null) } };
    },
  };
}

test('reduceBindings keeps only the currently-bound handles', () => {
  const events = [
    { kind: 'claimed' as const, handle: 'aquawolf', wallet: 'GAAA' },
    { kind: 'claimed' as const, handle: 'sorobuilder', wallet: 'GBBB' },
    { kind: 'released' as const, handle: 'aquawolf', wallet: 'GAAA' },
  ];
  const bound = reduceBindings(events);
  assert.deepEqual(
    bound.map((e) => e.handle),
    ['sorobuilder'],
  );
});

test('reduceBindings lets a handle be re-claimed after release', () => {
  const events = [
    { kind: 'claimed' as const, handle: 'aquawolf', wallet: 'GAAA' },
    { kind: 'released' as const, handle: 'aquawolf', wallet: 'GAAA' },
    { kind: 'claimed' as const, handle: 'aquawolf', wallet: 'GBBB' },
  ];
  const bound = reduceBindings(events);
  assert.equal(bound.length, 1);
  assert.equal(bound[0]!.wallet, 'GBBB');
});

test('reduceBindings updates the handle owner on transfer', () => {
  const events = [
    { kind: 'claimed' as const, handle: 'aquawolf', wallet: 'GOLD' },
    { kind: 'transferred' as const, handle: 'aquawolf', wallet: 'GNEW', from: 'GOLD' },
  ];
  const bound = reduceBindings(events);
  assert.deepEqual(bound, [{ handle: 'aquawolf', wallet: 'GNEW' }]);
});

test('reduceBindings sorts alphabetically for stable pagination', () => {
  const events = [
    { kind: 'claimed' as const, handle: 'zeta', wallet: 'GAAA' },
    { kind: 'claimed' as const, handle: 'alpha', wallet: 'GBBB' },
  ];
  const bound = reduceBindings(events);
  assert.deepEqual(
    bound.map((e) => e.handle),
    ['alpha', 'zeta'],
  );
});

test('reduceBindings returns nothing for an empty event list (empty-state case)', () => {
  assert.deepEqual(reduceBindings([]), []);
});

test('isRegistryConfigured is false without a contract id set', () => {
  // No REGISTRY_CONTRACT_ID / NEXT_PUBLIC_IDENTITY_REGISTRY_ID in this test env.
  assert.equal(isRegistryConfigured(), false);
});

test('listDirectory never marks a curated handle as bound when the registry is unconfigured', async () => {
  const { entries, boundTotal } = await listDirectory();
  const handles = entries.map((e) => e.handle);
  assert.ok(handles.includes('aquawolf'));
  assert.ok(handles.length >= 3);

  // The regression this guards: curated demo handles were previously returned
  // indistinguishable from on-chain bindings, and the page counted them as
  // "currently bound on the Identity Registry".
  assert.ok(
    entries.every((e) => e.bound === false),
    'no handle may be marked bound without a resolve() that returned a wallet',
  );
  assert.equal(entries.find((e) => e.handle === 'aquawolf')?.wallet, '');
  assert.equal(boundTotal, null, 'an unreadable registry reports null, not 0');
});

test('listDirectory marks only handles the contract resolves as bound', async () => {
  process.env.REGISTRY_CONTRACT_ID = CONTRACT_ID;
  try {
    const server = registryStub({ aquawolf: WALLET }, 1);
    const { entries, boundTotal } = await listDirectory({ server });

    const aquawolf = entries.find((e) => e.handle === 'aquawolf');
    assert.equal(aquawolf?.bound, true);
    assert.equal(aquawolf?.wallet, WALLET);

    for (const entry of entries.filter((e) => e.handle !== 'aquawolf')) {
      assert.equal(entry.bound, false, `${entry.handle} must not be marked bound`);
      assert.equal(entry.wallet, '');
    }

    // Bound entries lead, so the real binding is never buried under previews.
    assert.equal(entries[0]!.handle, 'aquawolf');
    assert.equal(boundTotal, 1);
  } finally {
    delete process.env.REGISTRY_CONTRACT_ID;
  }
});
