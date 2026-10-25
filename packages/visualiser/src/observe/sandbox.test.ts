import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeEvidence } from '@signet/spec';
import { fromSandboxTrace, UnsupportedTraceVersionError, type SandboxTrace } from './sandbox.ts';
import countTrace from '../../fixtures/sandbox/registry-count.trace.json' with { type: 'json' };
import claimTrace from '../../fixtures/sandbox/registry-claim.trace.json' with { type: 'json' };

// Real signet-simulator traces of the testnet registry on a fork at its
// recorded ledger (fixtures/sandbox/README.md).
const REGISTRY = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const REGISTRY_WASM = '936996c74b7d383c56ec174857b15927cdd29478c6909da332b4dec8b67335fe';

test('count: one unseeded sandbox observation, read-only, and a one-node tree', () => {
  const { observations, callTree, truncated } = fromSandboxTrace(countTrace as SandboxTrace);
  assert.equal(truncated, false);
  assert.equal(observations.length, 1);
  const [obs] = observations;
  assert.equal(obs!.contract, REGISTRY);
  assert.equal(obs!.function, 'count');
  assert.equal(obs!.source, 'sandbox');
  assert.equal(obs!.ledger, 4887004);
  assert.deepEqual(obs!.sandboxRun, { seeded: false, wasmHash: REGISTRY_WASM });
  assert.equal(obs!.successful, true);
  assert.deepEqual(
    obs!.readOnly.map((r) => r.kind),
    ['own-instance', 'own-code'],
    'the code key, owned by no contract, goes with the root',
  );
  assert.deepEqual(obs!.changed, []);
  assert.equal(writeEvidence(obs!), null);

  assert.equal(callTree.length, 1);
  assert.equal(callTree[0]!.function, 'count');
  assert.deepEqual(callTree[0]!.children, []);
});

test('claim: its storage writes are `changed` evidence, and the auth nonce is not', () => {
  const { observations } = fromSandboxTrace(claimTrace as SandboxTrace);
  const [obs] = observations;
  assert.equal(obs!.function, 'claim');
  assert.equal(writeEvidence(obs!), 'changed');
  assert.deepEqual(obs!.changed!.map((r) => r.kind).sort(), [
    'own-data',
    'own-data',
    'own-instance',
  ]);
  // The trace's read-write set holds the wallet's nonce too; it is dropped.
  const raw = (claimTrace as SandboxTrace).storage.flatMap((s) => s.read_write);
  assert.equal(raw.length, obs!.readWrite.length + 1);
  assert.ok(obs!.readWrite.every((r) => r.kind !== 'auth-nonce'));
});

test('a caller -> callee trace becomes a two-level tree and an observation per contract', () => {
  // The traced simulate in the protocol's golden transcript (#541).
  const transcript = readFileSync(
    new URL('../../../../sandbox/protocol/transcripts/trace.ndjson', import.meta.url),
    'utf8',
  );
  const line = transcript.split('\n').find((l) => l.includes('"trace":{'))!;
  const trace = (JSON.parse(line) as { trace: SandboxTrace }).trace;
  const { observations, callTree } = fromSandboxTrace(trace);

  assert.equal(callTree.length, 1);
  const [root] = callTree;
  assert.equal(root!.function, 'call_add');
  assert.equal(root!.children.length, 1);
  const [callee] = root!.children;
  assert.equal(callee!.function, 'add');
  assert.deepEqual(callee!.argsXdr, ['AAAAAwAAAAI=', 'AAAAAwAAAAM=']);
  assert.equal(callee!.resultXdr, 'AAAAAwAAAAU=');
  assert.equal(callee!.children.length, 0);

  assert.deepEqual(
    observations.map((o) => [o.contract, o.function, o.sandboxRun?.seeded]),
    [
      [root!.contract, 'call_add', true],
      [callee!.contract, 'add', true],
    ],
    'installed fixtures are seeded state',
  );
});

test('a contract entered with two functions has no single function', () => {
  const base = countTrace as SandboxTrace;
  const again = { ...base.frames[0]!, index: 1, parent: 0, depth: 1, function: 'resolve' };
  const { observations } = fromSandboxTrace({ ...base, frames: [base.frames[0]!, again] });
  assert.equal(observations[0]!.function, null);
});

test('an unknown trace version fails loudly, by name', () => {
  const v2 = { ...(countTrace as SandboxTrace), version: 2 };
  assert.throws(() => fromSandboxTrace(v2), UnsupportedTraceVersionError);
  assert.throws(() => fromSandboxTrace(v2), {
    message: 'trace schema v2 not supported by this visualiser (supports 1)',
  });
});
