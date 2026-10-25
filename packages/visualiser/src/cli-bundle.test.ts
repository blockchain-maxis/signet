/**
 * @file The Go CLI's bundle draws what the package draws (#544).
 *
 * For every fixture, the committed `cli/internal/visualise/bundle/visualiser.js`
 * is run in a `vm` context holding no globals at all, no Node and no DOM, as
 * close to goja as Node gets, and its SVG must be byte-identical to the
 * standalone golden the package itself renders (`__golden__/standalone/`).
 * A stale bundle fails here and in `scripts/check-visualiser-bundle.mjs`.
 *
 * `UPDATE_GOLDEN=1 pnpm --filter @signet/visualiser test` rewrites the
 * goldens from the package (never from the bundle).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from 'node:process';
import { toSpecJson } from '@signet/spec';
import { FIXTURES_DIR, loadFixture, readFixture } from './load-fixture.ts';
import { visualise, type VisualiseInput } from './visualise.ts';

const BUNDLE = join(
  FIXTURES_DIR,
  '..',
  '..',
  '..',
  'cli',
  'internal',
  'visualise',
  'bundle',
  'visualiser.js',
);
const GOLDEN_DIR = join(FIXTURES_DIR, '__golden__', 'standalone');

const fixtureNames = () =>
  readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.spec.json'))
    .map((f) => f.slice(0, -'.spec.json'.length))
    .sort();

function inputFor(name: string): VisualiseInput {
  const fixture = readFixture(name);
  return {
    specJson: toSpecJson(loadFixture(name)),
    theme: 'auto',
    address: fixture.address,
    network: fixture.network,
  };
}

/** A fresh, empty realm with the bundle loaded: what goja gives it. */
function bundleRealm(): vm.Context {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(BUNDLE, 'utf8'), context, { filename: 'visualiser.js' });
  return context;
}

/** Runs the bundle on plain JSON, as the CLI hands it over. */
function runBundle(
  context: vm.Context,
  input: VisualiseInput,
): { svg: string; decision: { kind: string }; wasmHash: string } {
  context.__input = JSON.stringify(input);
  return JSON.parse(
    vm.runInContext('JSON.stringify(signetVisualise(JSON.parse(__input)))', context) as string,
  );
}

test('the bundle defines signetVisualise and nothing else on the global object', () => {
  const context = bundleRealm();
  assert.deepEqual(Object.keys(context), ['signetVisualise']);
});

for (const name of fixtureNames()) {
  test(`the bundle's SVG for ${name} is byte-identical to the package's golden`, () => {
    const golden = join(GOLDEN_DIR, `${name}.svg`);
    const expected = visualise(inputFor(name));
    if (env.UPDATE_GOLDEN === '1') {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      if (!existsSync(golden) || readFileSync(golden, 'utf8') !== `${expected.svg}\n`) {
        writeFileSync(golden, `${expected.svg}\n`);
      }
    }
    assert.ok(existsSync(golden), `no golden for ${name}; run with UPDATE_GOLDEN=1`);
    assert.equal(
      `${expected.svg}\n`,
      readFileSync(golden, 'utf8'),
      'the package differs from its golden',
    );

    const got = runBundle(bundleRealm(), inputFor(name));
    assert.equal(
      `${got.svg}\n`,
      readFileSync(golden, 'utf8'),
      'the committed bundle draws differently: rebuild it with packages/visualiser/scripts/build-cli-bundle.mts',
    );
    assert.equal(got.decision.kind, expected.decision.kind);
    assert.equal(got.wasmHash, readFixture(name).wasmHash);
  });
}
