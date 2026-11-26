/**
 * @file The Go CLI's bundle draws what the package draws (#544).
 *
 * For every fixture, the committed `cli/internal/visualise/bundle/visualiser.js`
 * is run in a `vm` context holding no globals at all, no Node and no DOM, as
 * close to goja as Node gets, and its SVG must be byte-identical to the
 * standalone golden the package itself renders (`__golden__/standalone/`).
 * A stale bundle fails here and in `scripts/check-visualiser-bundle.mjs`.
 *
 * The bundle is also held to the Diagram tab's pipeline (#955): for every
 * fixture, with its groups collapsed and with its largest group expanded, it
 * must decide what the tab decides and draw the nodes the tab draws. The web
 * app's `lib/server/diagram-parity.test.ts` compares the tab, the export and
 * `visualise()` the same way.
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
import { canonicalExpand, collapseGroups, functionGroupsOf } from './collapse.ts';
import { diagramDecision } from './decide.ts';
import { buildContractGraph } from './graph.ts';
import { groupExpandKey } from './group.ts';
import { layoutContractGraph } from './layout.ts';
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

test('visualise on axelar-its returns decision.kind === "draw"', () => {
  const out = visualise(inputFor('axelar-its'));
  assert.equal(out.decision.kind, 'draw');
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

// The bundle against the Diagram tab's pipeline (#955).

/** `signetVisualise` takes the expanded groups as `expand` (#946). */
type InputWithExpand = VisualiseInput & { readonly expand?: string[] };

interface State {
  readonly label: string;
  /** Group keys, as `?expand=` carries them. */
  readonly expand: string[];
}

/** Groups collapsed, and the group with the most functions expanded; ties go to the first by name. */
function statesOf(name: string): State[] {
  const groups = functionGroupsOf(buildContractGraph(loadFixture(name)));
  const [largest] = [...groups].sort(
    (a, b) => b.functions.length - a.functions.length || a.name.localeCompare(b.name),
  );
  const key = largest ? groupExpandKey(largest, groups) : null;
  return [
    { label: 'groups collapsed', expand: [] },
    ...(key === null ? [] : [{ label: `group "${key}" expanded`, expand: [key] }]),
  ];
}

/**
 * What the Diagram tab does before it draws (`drawContractDiagram` in
 * `apps/web/lib/server/diagram-view.ts`): collapse the groups the URL does
 * not expand, lay the result out, then decide on it.
 */
function tabPipeline(name: string, expand: readonly string[]) {
  const full = buildContractGraph(loadFixture(name));
  const graph = collapseGroups(full, { expand: canonicalExpand(expand, full) });
  return { graph, decision: diagramDecision(graph, layoutContractGraph(graph)) };
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(apos|#39);/g, "'")
    .replace(/&amp;/g, '&');
}

/** The node titles of a standalone SVG, sorted: each node is a `<g data-node-kind>` titled with its name (the root and the legend have titles of their own). */
function nodeTitles(svg: string): string[] {
  return [...svg.matchAll(/<g data-node-kind="[^"]*"><title>([^<]*)<\/title>/g)]
    .map(([, title]) => unescapeXml(title!))
    .sort();
}

for (const name of fixtureNames()) {
  for (const state of statesOf(name)) {
    const where = `${name}, ${state.label}`;

    test(`the bundle decides and draws ${where}, as the Diagram tab's pipeline does`, () => {
      const tab = tabPipeline(name, state.expand);
      const input: InputWithExpand = {
        ...inputFor(name),
        ...(state.expand.length > 0 && { expand: state.expand }),
      };
      const source = visualise(input);
      const bundle = runBundle(bundleRealm(), input);

      // When the sources agree with the tab and the bundle does not, the bundle is what is behind.
      const sourceAgrees = source.decision.kind === tab.decision.kind;
      assert.ok(
        sourceAgrees && bundle.decision.kind === tab.decision.kind,
        `${where}: the Diagram tab's pipeline decides ${tab.decision.kind}, ` +
          `visualise() decides ${source.decision.kind}, ` +
          `the committed bundle decides ${bundle.decision.kind}.` +
          (sourceAgrees
            ? ' The bundle is stale: rebuild it with packages/visualiser/scripts/build-cli-bundle.mts.'
            : ''),
      );
      if (tab.decision.kind !== 'draw') return;

      const drawn = tab.graph.nodes.map((n) => n.name).sort();
      assert.deepEqual(
        nodeTitles(source.svg),
        drawn,
        `${where}: visualise() and the Diagram tab's pipeline draw different nodes`,
      );
      assert.deepEqual(
        nodeTitles(bundle.svg),
        drawn,
        `${where}: the committed bundle and the Diagram tab's pipeline draw different nodes: rebuild it with packages/visualiser/scripts/build-cli-bundle.mts`,
      );
    });
  }
}

// On fixtures small enough to draw without collapsing, a bundle that never
// collapses would agree with the tab. The comparison means something only
// while a committed fixture is drawn with collapsed groups.
test('a fixture is drawn only because its groups collapse', () => {
  const collapsing = fixtureNames().filter((name) => {
    const { graph, decision } = tabPipeline(name, []);
    return (
      decision.kind === 'draw' && graph.nodes.some((n) => n.kind === 'function' && n.collapsed)
    );
  });
  assert.ok(collapsing.length >= 1, 'no committed fixture is drawn with collapsed groups');
});
