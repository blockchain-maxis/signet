import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { nativeToScVal, type Transaction } from '@stellar/stellar-sdk';
import {
  boundCount,
  isRegistryConfigured,
  lookupWallet,
  resolveHandle,
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

test('boundCount returns 0 when the registry is unconfigured', async () => {
  assert.equal(await boundCount(), 0);
});

test('an unconfigured registry never reaches the RPC server', async () => {
  const server = stubServer(successWith(nativeToScVal('aquawolf', { type: 'string' })));
  assert.equal(await resolveHandle('aquawolf', { server }), null);
  assert.equal(await lookupWallet(WALLET, { server }), null);
  assert.equal(await boundCount({ server }), 0);
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

test('boundCount returns 0 when simulation reports an error', async () => {
  configureRegistry();
  const server = stubServer({ error: 'HostError: contract not found' });
  assert.equal(await boundCount({ server }), 0);
});

test('a throwing RPC client is swallowed rather than propagated', async () => {
  configureRegistry();
  const server = throwingServer();
  assert.equal(await resolveHandle('aquawolf', { server }), null);
  assert.equal(await lookupWallet(WALLET, { server }), null);
  assert.equal(await boundCount({ server }), 0);
});

test('a simulation with no return value resolves to the unbound answer', async () => {
  configureRegistry();
  const server = stubServer({ result: undefined });
  assert.equal(await resolveHandle('aquawolf', { server }), null);
  assert.equal(await boundCount({ server }), 0);
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
