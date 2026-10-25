import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpecJson } from '@signet/spec';
import type { SandboxTrace } from '@signet/visualiser';
import { drawBuild, localMarks, decodeSpec, storageRows, traceRows, truncationNotice } from './diagram.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');

/** The caller -> callee trace (#529, #541) from the protocol transcript: call_add calling add. */
function callerCalleeTrace(): SandboxTrace {
  const lines = readFileSync(join(root, 'sandbox/protocol/transcripts/trace.ndjson'), 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line) as { type?: string; trace?: SandboxTrace };
    if (message.type === 'result' && message.trace?.frames.length === 2) return message.trace;
  }
  throw new Error('no two-frame trace in the transcript');
}

const fn = (name: string) => ({ name, doc: '', isConstructor: false, inputs: [], outputs: [] });
const specJson = (functions: string[], wasmHash = 'a'.repeat(64)): SpecJson => ({
  schemaVersion: 1,
  wasmHash,
  sdkVersion: '16.1.0',
  entriesXdr: [],
  functions: functions.map(fn),
  types: [],
  errors: [],
  events: [],
  warnings: [],
});

test('the caller -> callee trace shows two frames, the callee nested under the caller', () => {
  const trace = callerCalleeTrace();
  const rows = traceRows(trace, null);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.depth, r.a?.function]),
    [
      [0, 'call_add'],
      [1, 'add'],
    ],
  );
  assert.ok(rows.every((r) => !r.differs), 'one side: nothing to differ from');
  assert.equal(truncationNotice(trace), null);
  assert.equal(storageRows(trace).length, 3);
});

test('A/B mode highlights the frame whose result differs, and only it', () => {
  const a = callerCalleeTrace();
  const b: SandboxTrace = {
    ...a,
    frames: a.frames.map((f) => (f.index === 1 ? { ...f, result_xdr: 'AAAAAwAAAAY=' } : f)),
  };
  const rows = traceRows(a, b);
  assert.deepEqual(
    rows.map((r) => r.differs),
    [false, true],
  );
  const truncated = { ...b, truncated: true, frame_count: 12_000, max_frames: 10_000 };
  assert.equal(truncationNotice(truncated), 'Trace truncated: 12000 frames ran, the first 10000 are shown.');
});

test('a hot-swap that adds a function draws it with an added badge', () => {
  const contract = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
  const drawn = drawBuild({
    contract,
    deployed: specJson(['get']),
    local: specJson(['get', 'increment'], 'b'.repeat(64)),
    outcomes: [],
  });
  assert.deepEqual(drawn.diff, { added: ['fn:increment'], removed: [], changed: [] });
  assert.match(drawn.svg, /data-node-id="fn:increment" data-diff="added"/);
  assert.match(drawn.svg, /data-diff-badge="added"/);
  assert.doesNotMatch(drawn.svg, /data-node-id="fn:get"[^>]*data-diff/);
});

test('a sandbox claim marks claim as writing, labelled as a local sandbox run', () => {
  const claim = JSON.parse(
    readFileSync(join(root, 'packages/visualiser/fixtures/sandbox/registry-claim.trace.json'), 'utf8'),
  ) as SandboxTrace;
  const contract = claim.frames[0]!.contract;
  const local = specJson(['claim', 'count'], claim.frames[0]!.wasm_hash!);
  const { marks, runs } = localMarks(decodeSpec(local), contract, [{ name: 'claim', a: {}, b: { result: { trace: claim } } }]);
  assert.equal(runs, 1);
  assert.equal(marks.claim?.kind, 'writes');
  assert.equal(marks.count?.kind, 'unknown');
  const drawn = drawBuild({ contract, deployed: null, local, outcomes: [{ name: 'claim', a: {}, b: { result: { trace: claim } } }] });
  assert.match(drawn.svg, /data-node-id="fn:claim"[^>]*data-mark="write"[^>]*data-mark-source="local sandbox"/);
  assert.match(drawn.svg, /Read\/write marks from 1 local sandbox run on this machine, not from the chain\./);
});

test('the UI only ever fetches its own local API', () => {
  const sources = readdirSync(here)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'))
    .map((f) => [f, readFileSync(join(here, f), 'utf8')] as const);
  for (const [file, text] of sources) {
    for (const call of text.matchAll(/fetch\(\s*([`'"])([^`'"]*)/g)) {
      assert.ok(call[2]!.startsWith('/api/'), `${file} fetches ${call[2]}`);
    }
    assert.doesNotMatch(text, /new (WebSocket|EventSource)\(|navigator\.sendBeacon/, file);
  }
});
