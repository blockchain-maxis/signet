import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContractSpec, toSpecJson } from '@signet/spec';
import {
  ACTIVITY_NOT_MEASURED,
  buildProvenanceLine,
  classifySpecError,
  failureCopy,
  summariseActivity,
  summariseSpec,
  withFlattenedViews,
  type SpecFailure,
} from './contract-overview.ts';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'spec',
  'fixtures',
);

/**
 * A fixture as the page sees a spec off the network: decoded from the WASM,
 * serialised, then given its flattened views from `entriesXdr`.
 */
function fixture(name: string) {
  return withFlattenedViews(
    toSpecJson(parseContractSpec(readFileSync(join(FIXTURES, `${name}.wasm`)))),
  );
}

/** The registry WASM from #422: the deployed identity registry, 8 functions, all documented. */
const registry = fixture('identity-registry');

test('registry fixture: 8 functions, 8 of 8 documented, and the spec error count', () => {
  const summary = summariseSpec({ kind: 'spec', spec: registry });
  assert.equal(summary.status, 'ok');
  if (summary.status !== 'ok') return;

  assert.equal(summary.interface.functionCount, 8);
  assert.equal(summary.interface.documentedFunctions, 8);
  assert.equal(summary.interface.coverage, '8 of 8 functions documented');
  assert.equal(summary.interface.functionsLabel, '8 functions');

  // The registry defines 7 error cases and no user types.
  assert.equal(summary.interface.errorCount, 7);
  assert.equal(summary.interface.errorsLabel, '7 error cases');
  assert.equal(summary.interface.typeCount, 0);
  assert.equal(summary.interface.typesLabel, '0 types');
});

test('build provenance is shown only when contractmetav0 supplied it', () => {
  const withBuild = summariseSpec({
    kind: 'spec',
    spec: {
      functions: [],
      types: [],
      errors: [],
      build: { rustVersion: '1.91.1', sdkVersion: '26.1.0' },
    },
  });
  assert.equal(
    withBuild.status === 'ok' && withBuild.build,
    'Built with Rust 1.91.1 and soroban-sdk 26.1.0',
  );
  // The fixture spec carries no build metadata (#432), so no line, and no "unknown".
  const without = summariseSpec({ kind: 'spec', spec: registry });
  assert.equal(without.status === 'ok' && without.build, null);
});

test('withFlattenedViews fills empty views from entriesXdr and leaves populated ones alone', () => {
  const json = toSpecJson(
    parseContractSpec(readFileSync(join(FIXTURES, 'identity-registry.wasm'))),
  );
  assert.equal(json.functions.length, 0, 'the RPC reader leaves the views empty');
  const filled = withFlattenedViews(json);
  assert.equal(filled.functions.length, 8);
  assert.equal(withFlattenedViews(filled), filled, 'already populated: returned as is');
});

test('undocumented fixture: 0 of N documented, stated plainly, no invented prose', () => {
  const spec = fixture('undocumented');
  const summary = summariseSpec({ kind: 'spec', spec });
  assert.equal(summary.status, 'ok');
  if (summary.status !== 'ok') return;
  const n = spec.functions.length;
  assert.ok(n > 0);
  assert.equal(summary.interface.documentedFunctions, 0);
  assert.equal(
    summary.interface.coverage,
    `0 of ${n} ${n === 1 ? 'function' : 'functions'} documented`,
  );
  assert.doesNotMatch(JSON.stringify(summary), /No description available/i);
});

test('doc coverage counts only non-blank doc comments', () => {
  const summary = summariseSpec({
    kind: 'spec',
    spec: {
      functions: [{ doc: 'Does a thing.' }, { doc: '' }, { doc: '   \n ' }, {}],
      types: [],
      errors: [],
    },
  });
  assert.equal(summary.status, 'ok');
  if (summary.status !== 'ok') return;
  assert.equal(summary.interface.coverage, '1 of 4 functions documented');
  assert.equal(summary.build, null, 'no contractmetav0 means no build line, not "unknown"');
});

test('singular counts use singular nouns; zero functions has no coverage line', () => {
  const one = summariseSpec({
    kind: 'spec',
    spec: { functions: [{ doc: 'x' }], types: [{}], errors: [{}] },
  });
  assert.equal(one.status, 'ok');
  if (one.status === 'ok') {
    assert.equal(one.interface.functionsLabel, '1 function');
    assert.equal(one.interface.typesLabel, '1 type');
    assert.equal(one.interface.errorsLabel, '1 error case');
    assert.equal(one.interface.coverage, '1 of 1 function documented');
  }
  const none = summariseSpec({ kind: 'spec', spec: { functions: [], types: [], errors: [] } });
  assert.equal(none.status, 'ok');
  if (none.status === 'ok') assert.equal(none.interface.coverage, null);
});

test('buildProvenanceLine handles partial and absent metadata', () => {
  assert.equal(buildProvenanceLine(undefined), null);
  assert.equal(buildProvenanceLine({}), null);
  assert.equal(buildProvenanceLine({ rustVersion: '1.91.1' }), 'Built with Rust 1.91.1');
  assert.equal(buildProvenanceLine({ sdkVersion: '26.1.0' }), 'Built with soroban-sdk 26.1.0');
});

test('§1.5 failure: not found names the network, exact copy', () => {
  const summary = summariseSpec({
    kind: 'failure',
    failure: { kind: 'contract_not_found', network: 'testnet' },
  });
  assert.deepEqual(summary, {
    status: 'failure',
    build: null,
    failure: {
      kind: 'contract_not_found',
      title: 'Not found on testnet',
      detail:
        'No contract with this address exists on testnet. Check that the network is the one it was deployed to.',
    },
  });
});

test('§1.5 failure: no interface is a statement about the contract, with no detail added', () => {
  const summary = summariseSpec({ kind: 'failure', failure: { kind: 'no_interface' } });
  assert.deepEqual(summary, {
    status: 'failure',
    build: null,
    failure: {
      kind: 'no_interface',
      title: 'This contract publishes no interface',
      detail: null,
    },
  });
});

test('§1.5 failure: unreadable names the SDK version, exact copy', () => {
  const summary = summariseSpec({
    kind: 'failure',
    failure: { kind: 'interface_unreadable', sdkVersion: '16.1.0' },
  });
  assert.deepEqual(summary, {
    status: 'failure',
    build: null,
    failure: {
      kind: 'interface_unreadable',
      title: 'Interface could not be read',
      detail: 'Decoding failed with @stellar/stellar-sdk 16.1.0.',
    },
  });
});

test('an unreachable RPC is its own state, not "no interface"', () => {
  const copy = failureCopy({ kind: 'unavailable' });
  assert.equal(copy.title, 'Interface is unavailable right now');
  assert.doesNotMatch(copy.title, /no interface/i);
});

test('no failure carries counts, and none invents a description', () => {
  const failures: SpecFailure[] = [
    { kind: 'contract_not_found', network: 'mainnet' },
    { kind: 'no_interface' },
    { kind: 'interface_unreadable', sdkVersion: '16.1.0' },
    { kind: 'unavailable' },
  ];
  for (const failure of failures) {
    const summary = summariseSpec({ kind: 'failure', failure });
    assert.equal(summary.status, 'failure');
    assert.ok(!('interface' in summary), failure.kind);
    assert.doesNotMatch(JSON.stringify(summary), /No description available/i);
  }
});

test('classifySpecError maps the resolver’s typed errors and defaults to unavailable', () => {
  assert.deepEqual(classifySpecError({ kind: 'contract_not_found' }, 'testnet'), {
    kind: 'contract_not_found',
    network: 'testnet',
  });
  assert.deepEqual(classifySpecError({ kind: 'no_interface', reason: 'no_section' }, 'testnet'), {
    kind: 'no_interface',
  });
  assert.deepEqual(
    classifySpecError({ kind: 'interface_unreadable', sdkVersion: '16.1.0' }, 'testnet'),
    { kind: 'interface_unreadable', sdkVersion: '16.1.0' },
  );
  assert.deepEqual(classifySpecError({ kind: 'rpc_unavailable' }, 'testnet'), {
    kind: 'unavailable',
  });
  assert.deepEqual(classifySpecError(new Error('boom'), 'testnet'), { kind: 'unavailable' });
  assert.deepEqual(classifySpecError(null, 'testnet'), { kind: 'unavailable' });
});

test('activity: no snapshot, or a snapshot without countedSince, is "not measured"', () => {
  const unmeasured = { measured: false, message: ACTIVITY_NOT_MEASURED };
  assert.deepEqual(summariseActivity(null), unmeasured);
  // A zero written before #429 means "not measured", never "no usage".
  assert.deepEqual(
    summariseActivity({
      txCount24h: 0,
      txCountTotal: 0,
      countedSince: null,
      capturedAt: new Date('2026-03-10T00:00:00Z'),
    }),
    unmeasured,
  );
  assert.doesNotMatch(ACTIVITY_NOT_MEASURED, /no (usage|activity|calls)/i);
});

test('activity: a measured snapshot pairs the total with its start, floor as {n}+', () => {
  const base = {
    txCount24h: 3,
    txCountTotal: 42,
    countedSince: new Date('2026-03-01T12:00:00Z'),
    lastActivity: new Date('2026-03-10T08:30:00Z'),
    capturedAt: new Date('2026-03-10T09:00:00Z'),
  };
  assert.deepEqual(summariseActivity(base), {
    measured: true,
    last24h: '3',
    total: '42',
    since: 'since 2026-03-01',
    lastActivity: '2026-03-10',
  });
  const floor = summariseActivity({ ...base, totalIsFloor: true, lastActivity: null });
  assert.equal(floor.measured, true);
  if (floor.measured) {
    assert.equal(floor.total, '42+');
    assert.equal(floor.since, 'since 2026-03-01');
    assert.equal(floor.lastActivity, null);
  }
});
