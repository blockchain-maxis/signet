import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { nativeToScVal, type Transaction } from '@stellar/stellar-sdk';
import {
  boundCount,
  isRegistryConfigured,
  lookupWallet,
  resolveHandle,
  resolveHandleDetailed,
  type SimulatingServer,
} from './registry-read.ts';

// A structurally valid contract id — never deployed, and never reached either:
// every test here injects a stub server instead of talking to an RPC endpoint.
const CONTRACT_ID = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';
const WALLET = 'GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG';

function configureRegistry(): void {
  process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID = CONTRACT_ID;
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID;
});

/** Stub server that returns whatever simulation response it was handed. */
function stubServer(response: unknown): SimulatingServer & { calls: Transaction[] } {
  const calls: Transaction[] = [];
  return {
    calls,
    async simulateTransaction(tx: Transaction) {
      calls.push(tx);
      return response;
    },
  };
}

/** Stub server standing in for an unreachable RPC endpoint. */
function throwingServer(): SimulatingServer {
  return {
    async simulateTransaction() {
      throw new Error('connect ECONNREFUSED');
    },
  };
}

function successWith(retval: ReturnType<typeof nativeToScVal>) {
  return { result: { retval } };
}

// ── unconfigured registry ─────────────────────────────────────────────────

test('isRegistryConfigured is false without a contract id set', () => {
  assert.equal(isRegistryConfigured(), false);
});

test('isRegistryConfigured picks the contract id up from the environment', () => {
  configureRegistry();
  assert.equal(isRegistryConfigured(), true);
});

test('resolveHandle returns null when the registry is unconfigured', async () => {
  assert.equal(await resolveHandle('aquawolf'), null);
});

test('lookupWallet returns null when the registry is unconfigured', async () => {
  assert.equal(await lookupWallet(WALLET), null);
});

test('boundCount returns null when the registry is unconfigured', async () => {
  // Null, not 0 — an unreadable registry must never render as an empty one.
  assert.equal(await boundCount(), null);
});

test('an unconfigured registry never reaches the RPC server', async () => {
  const server = stubServer(successWith(nativeToScVal('aquawolf', { type: 'string' })));
  assert.equal(await resolveHandle('aquawolf', { server }), null);
  assert.equal(await lookupWallet(WALLET, { server }), null);
  assert.equal(await boundCount({ server }), null);
  assert.equal(server.calls.length, 0);
});

// ── simulation errors ─────────────────────────────────────────────────────

test('resolveHandle returns null when simulation reports an error', async () => {
  configureRegistry();
  const server = stubServer({ error: 'HostError: contract not found' });
  assert.equal(await resolveHandle('aquawolf', { server }), null);
});

test('lookupWallet returns null when simulation reports an error', async () => {
  configureRegistry();
  const server = stubServer({ error: 'HostError: contract not found' });
  assert.equal(await lookupWallet(WALLET, { server }), null);
});

test('boundCount returns null when simulation reports an error', async () => {
  configureRegistry();
  const server = stubServer({ error: 'HostError: contract not found' });
  assert.equal(await boundCount({ server }), null);
});

test('a throwing RPC client is swallowed rather than propagated', async () => {
  configureRegistry();
  const server = throwingServer();
  assert.equal(await resolveHandle('aquawolf', { server }), null);
  assert.equal(await lookupWallet(WALLET, { server }), null);
  assert.equal(await boundCount({ server }), null);
});

test('a simulation with no return value resolves to the unbound answer', async () => {
  configureRegistry();
  const server = stubServer({ result: undefined });
  assert.equal(await resolveHandle('aquawolf', { server }), null);
  assert.equal(await boundCount({ server }), null);
});

test('boundCount distinguishes a genuinely empty registry from an unreadable one', async () => {
  configureRegistry();
  const empty = stubServer(successWith(nativeToScVal(0, { type: 'u32' })));
  assert.equal(await boundCount({ server: empty }), 0);
  assert.equal(await boundCount({ server: throwingServer() }), null);
});

// ── decoding live values ──────────────────────────────────────────────────

test('resolveHandle decodes the bound wallet address', async () => {
  configureRegistry();
  const server = stubServer(successWith(nativeToScVal(WALLET, { type: 'address' })));
  assert.equal(await resolveHandle('aquawolf', { server }), WALLET);
  assert.equal(server.calls.length, 1);
});

test('resolveHandle treats an unbound handle (void return) as null', async () => {
  configureRegistry();
  const server = stubServer(successWith(nativeToScVal(null)));
  assert.equal(await resolveHandle('aquawolf', { server }), null);
});

test('lookupWallet decodes the bound handle', async () => {
  configureRegistry();
  const server = stubServer(successWith(nativeToScVal('aquawolf', { type: 'string' })));
  assert.equal(await lookupWallet(WALLET, { server }), 'aquawolf');
});

test('lookupWallet treats a wallet with no handle as null', async () => {
  configureRegistry();
  const server = stubServer(successWith(nativeToScVal(null)));
  assert.equal(await lookupWallet(WALLET, { server }), null);
});

test('boundCount decodes the u32 count', async () => {
  configureRegistry();
  const server = stubServer(successWith(nativeToScVal(42, { type: 'u32' })));
  assert.equal(await boundCount({ server }), 42);
});

// ── input guards (no RPC round-trip wasted on junk) ───────────────────────

test('resolveHandle rejects a malformed handle without simulating', async () => {
  configureRegistry();
  const server = stubServer(successWith(nativeToScVal(WALLET, { type: 'address' })));
  assert.equal(await resolveHandle('Not A Handle!', { server }), null);
  assert.equal(server.calls.length, 0);
});

test('lookupWallet rejects a malformed address without simulating', async () => {
  configureRegistry();
  const server = stubServer(successWith(nativeToScVal('aquawolf', { type: 'string' })));
  assert.equal(await lookupWallet('not-a-wallet', { server }), null);
  assert.equal(server.calls.length, 0);
});

// ── archival and detailed resolution ─────────────────────────────────────

test('resolveHandleDetailed returns bound status and wallet for live handle', async () => {
  configureRegistry();
  const server = stubServer(successWith(nativeToScVal(WALLET, { type: 'address' })));
  const res = await resolveHandleDetailed('aquawolf', { server });
  assert.deepEqual(res, { status: 'bound', wallet: WALLET });
});

test('resolveHandleDetailed detects an archived footprint', async () => {
  configureRegistry();
  // An archived entry does not fail the simulation: the network answers "as
  // if" the entry were live — so the response is a *success* (top-level
  // `transactionData`, which is what the SDK's isSimulationSuccess keys on)
  // that additionally carries a `restorePreamble` naming what to restore. A
  // fixture with only the preamble is not a shape the RPC ever returns.
  const server = stubServer({
    transactionData: 'AAAAsimulated',
    result: { retval: nativeToScVal(WALLET, { type: 'address' }) },
    restorePreamble: { minResourceFee: '1000', transactionData: 'AAAArestore' },
  });
  const res = await resolveHandleDetailed('aquawolf', { server });
  assert.equal(res.status, 'archived');
  assert.ok('restorePreamble' in res);
});

test('a successful simulation with no restorePreamble is not treated as archived', async () => {
  configureRegistry();
  // Guards the inverse: every healthy read must not be reported as archived.
  const server = stubServer({
    transactionData: 'AAAAsimulated',
    result: { retval: nativeToScVal(WALLET, { type: 'address' }) },
  });
  assert.deepEqual(await resolveHandleDetailed('aquawolf', { server }), {
    status: 'bound',
    wallet: WALLET,
  });
});

test('resolveHandleDetailed returns unbound for unbound handle', async () => {
  configureRegistry();
  const server = stubServer(successWith(nativeToScVal(null)));
  const res = await resolveHandleDetailed('aquawolf', { server });
  assert.deepEqual(res, { status: 'unbound' });
});

test('resolveHandleDetailed returns unconfigured without contract id', async () => {
  const res = await resolveHandleDetailed('aquawolf');
  assert.deepEqual(res, { status: 'unconfigured' });
});
