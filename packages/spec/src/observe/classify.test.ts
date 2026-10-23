import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContractSpec } from '../parse.ts';
import { classifyFunctions, describeIgnored, describeMark, writeEvidence } from './classify.ts';
import { classifyLedgerKey, normaliseFootprint, type RawFootprint } from './normalise.ts';
import { claimFixture, countFixture } from './testnet-fixtures.ts';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
// The Identity Registry's real compiled spec: claim, count, resolve, ...
const spec = parseContractSpec(readFileSync(join(FIXTURES_DIR, 'identity-registry.wasm')));
const OLD_HASH = '00'.repeat(32);

// The testnet captures carry no executable hash, so each test states the
// version it attributes them to.
const observe = (raw: RawFootprint, overrides: Partial<RawFootprint> = {}) =>
  normaliseFootprint({ ...raw, wasmHash: spec.wasmHash, ...overrides });

test('the registry spec exports the functions these tests classify', () => {
  const names = spec.functions.map((f) => f.name);
  for (const name of ['claim', 'count', 'resolve']) assert.ok(names.includes(name), `${name} in ${names}`);
});

test('writes: a successful claim whose meta shows its own storage changed', () => {
  const mark = classifyFunctions(spec, [observe(claimFixture)]).get('claim')!;
  assert.equal(mark.kind, 'writes');
  assert.ok(mark.kind === 'writes');
  assert.equal(mark.evidence, 'changed');
  assert.deepEqual(mark.example, { source: 'transaction', ledger: claimFixture.ledger, txHash: claimFixture.txHash });
  assert.equal(describeMark(mark), 'wrote in 1 of 1 observed call (confirmed by transaction meta)');
});

test('writes, declared: without meta, a readWrite own-data key is declared evidence only', () => {
  const mark = classifyFunctions(spec, [observe(claimFixture, { changed: null })]).get('claim')!;
  assert.ok(mark.kind === 'writes');
  assert.equal(mark.evidence, 'declared');
  assert.match(describeMark(mark), /declared in the footprint/);
});

test('with meta, a declared write that meta does not confirm is not write evidence', () => {
  // Same declared footprint, but meta reports only the nonce changing (dropped by #509).
  const nonceOnly = claimFixture.changed!.filter(
    (raw) => classifyLedgerKey(raw, claimFixture.contract).kind === 'auth-nonce',
  );
  assert.equal(nonceOnly.length, 1, 'the captured meta changed exactly one nonce');
  const obs = observe(claimFixture, { changed: nonceOnly });
  assert.equal(writeEvidence(obs), null);
  assert.equal(classifyFunctions(spec, [obs]).get('claim')!.kind, 'no-writes-seen');
});

test('no-writes-seen: count, observed twice, carries N and the ledger range — never "read-only"', () => {
  const mark = classifyFunctions(spec, [observe(countFixture), observe(countFixture, { ledger: countFixture.ledger + 40 })]).get('count')!;
  assert.deepEqual(mark, {
    kind: 'no-writes-seen',
    observations: 2,
    firstLedger: countFixture.ledger,
    lastLedger: countFixture.ledger + 40,
    seededOnly: false,
    staleObservations: 0,
    unversionedObservations: 0,
    seededObservations: 0,
  });
  const text = describeMark(mark);
  assert.equal(text, `no writes seen in 2 observed calls (ledgers ${countFixture.ledger}–${countFixture.ledger + 40})`);
  assert.doesNotMatch(text, /read-only/i);
});

test('unknown: a spec function nothing observed', () => {
  const marks = classifyFunctions(spec, [observe(claimFixture)]);
  assert.equal(marks.get('resolve')!.kind, 'unknown');
  assert.equal(describeMark(marks.get('resolve')!), 'not observed');
  // Every spec function gets a mark.
  assert.deepEqual([...marks.keys()].sort(), spec.functions.map((f) => f.name).sort());
});

test('a function seen once writing and once not is writes, "wrote in 1 of 2 observed calls"', () => {
  const quietClaim = observe(claimFixture, { ledger: claimFixture.ledger + 1, readWrite: [], changed: [] });
  const mark = classifyFunctions(spec, [observe(claimFixture), quietClaim]).get('claim')!;
  assert.ok(mark.kind === 'writes');
  assert.equal(mark.writingObservations, 1);
  assert.equal(mark.observations, 2);
  assert.match(describeMark(mark), /^wrote in 1 of 2 observed calls/);
});

test('mismatched wasmHash: earlier-version observations are reported as stale, never counted', () => {
  const marks = classifyFunctions(spec, [
    observe(claimFixture, { wasmHash: OLD_HASH }),
    observe(claimFixture, { wasmHash: OLD_HASH, ledger: claimFixture.ledger + 5 }),
    observe(countFixture),
  ]);
  const claim = marks.get('claim')!;
  assert.equal(claim.kind, 'unknown', 'a previous version writing says nothing about this one');
  assert.equal(claim.staleObservations, 2);
  assert.equal(describeIgnored(claim), '2 observations from a previous version ignored');
  assert.equal(describeIgnored(marks.get('count')!), null);

  // A capture with no recorded hash cannot be attributed to a version either.
  const unversioned = classifyFunctions(spec, [observe(claimFixture, { wasmHash: null })]).get('claim')!;
  assert.equal(unversioned.kind, 'unknown');
  assert.equal(unversioned.unversionedObservations, 1);
  assert.equal(describeIgnored(unversioned), '1 observation with no recorded version ignored');
});

test('a failed transaction counts only as declared, never changed', () => {
  // Meta from a failed tx is ignored even when it lists own-data keys.
  const failed = observe(claimFixture, { successful: false });
  assert.equal(writeEvidence(failed), 'declared');
  const mark = classifyFunctions(spec, [failed]).get('claim')!;
  assert.ok(mark.kind === 'writes');
  assert.equal(mark.evidence, 'declared');
  // A successful, meta-confirmed call is stronger and becomes the example.
  const both = classifyFunctions(spec, [failed, observe(claimFixture, { ledger: claimFixture.ledger - 1 })]).get('claim')!;
  assert.ok(both.kind === 'writes');
  assert.equal(both.evidence, 'changed');
  assert.equal(both.example.ledger, claimFixture.ledger - 1);
});

test('seeded sandbox runs are kept but flagged, and never outweigh chain evidence', () => {
  const seededRun = (overrides: Partial<RawFootprint>) =>
    observe(claimFixture, {
      source: 'sandbox',
      txHash: undefined,
      wasmHash: null,
      sandboxRun: { seeded: true, wasmHash: spec.wasmHash },
      ...overrides,
    });

  // On its own a seeded run decides the mark, and the mark says so.
  const alone = classifyFunctions(spec, [seededRun({})]).get('claim')!;
  assert.ok(alone.kind === 'writes');
  assert.equal(alone.seededOnly, true);
  assert.equal(alone.seededObservations, 1);
  assert.match(describeMark(alone), /seeded sandbox runs only/);

  // Chain evidence of no writes is not overturned by a seeded run that wrote.
  const withChain = classifyFunctions(spec, [seededRun({}), observe(claimFixture, { readWrite: [], changed: [] })]).get('claim')!;
  assert.equal(withChain.kind, 'no-writes-seen');
  assert.ok(withChain.kind === 'no-writes-seen');
  assert.equal(withChain.observations, 1, 'the seeded run is not counted towards the chain mark');
  assert.equal(withChain.seededOnly, false);
  assert.equal(withChain.seededObservations, 1, 'but it is still reported');

  // An unseeded sandbox run is ordinary evidence.
  const unseeded = classifyFunctions(spec, [seededRun({ sandboxRun: { seeded: false, wasmHash: spec.wasmHash } })]).get('claim')!;
  assert.ok(unseeded.kind === 'writes');
  assert.equal(unseeded.seededOnly, false);
  assert.equal(unseeded.seededObservations, 0);
});

test('observations naming no function, or one the spec does not export, are ignored', () => {
  const marks = classifyFunctions(spec, [observe(claimFixture, { function: null }), observe(claimFixture, { function: 'not_exported' })]);
  assert.equal(marks.get('claim')!.kind, 'unknown');
  assert.equal(marks.has('not_exported'), false);
});
