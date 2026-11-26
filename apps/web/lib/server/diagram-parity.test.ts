/**
 * @file The surfaces that draw a contract's interface diagram agree (#955).
 *
 * Three functions draw it: `drawContractDiagram` (the Diagram tab, its
 * fragment route and the embed), `exportContractDiagram` (Download SVG, and
 * the PNG rasterised from that URL) and `visualise()` (what the bundle behind
 * `signet visualise` runs). Nothing compared them, and they drifted (#946):
 * the tab collapsed function groups before deciding what to draw, the other
 * two decided on the raw graph.
 *
 * For every committed fixture, once with its groups collapsed and once with
 * its largest group expanded, the three must reach one decision, and when the
 * decision is to draw they must draw the same nodes. The committed bundle is
 * held to the same pipeline in `packages/visualiser/src/cli-bundle.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { toSpecJson, type ContractSpec } from '@signet/spec';
import { buildContractGraph, functionGroupsOf, groupExpandKey } from '@signet/visualiser';
import { normalizeNetwork } from '@signet/types';
import {
  FIXTURES_DIR,
  loadFixture,
  readFixture,
} from '../../../../packages/visualiser/src/load-fixture.ts';
import { visualise, type VisualiseInput } from '../../../../packages/visualiser/src/visualise.ts';
import { drawContractDiagram, __resetDiagramViewCache, type DiagramView } from './diagram-view.ts';
import { exportContractDiagram, type DiagramExportDeps } from './diagram-export.ts';

const HANDLE = 'alice';

const fixtureNames = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.spec.json'))
  .map((f) => f.slice(0, -'.spec.json'.length))
  .sort();

/** `visualise()` takes the expanded groups as `expand` (#946). */
type VisualiseWithExpand = VisualiseInput & { readonly expand?: string[] };

interface State {
  /** For test names and failure messages. */
  readonly label: string;
  /** Group keys, as `?expand=` carries them. */
  readonly expand: string[];
}

/** The `?expand=` key of the group with the most functions; ties go to the first by name. */
function largestGroupKey(spec: ContractSpec): string | null {
  const groups = functionGroupsOf(buildContractGraph(spec));
  const [largest] = [...groups].sort(
    (a, b) => b.functions.length - a.functions.length || a.name.localeCompare(b.name),
  );
  return largest ? groupExpandKey(largest, groups) : null;
}

function statesOf(spec: ContractSpec): State[] {
  const largest = largestGroupKey(spec);
  return [
    { label: 'groups collapsed', expand: [] },
    ...(largest === null ? [] : [{ label: `group "${largest}" expanded`, expand: [largest] }]),
  ];
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(apos|#39);/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The names of the nodes in the tab's SVG, sorted. The tab marks a node with
 * its id (`data-node-id`) and the standalone SVG titles it with its name, so
 * the ids go through the tab's own model to become names.
 */
function tabNodeNames(view: DiagramView, where: string): string[] {
  const nameById = new Map(view.model.nodes.map((n) => [n.id, n.name] as const));
  return [...view.regionHtml.matchAll(/ data-node-id="([^"]*)"/g)]
    .map(([, raw]) => {
      const id = unescapeXml(raw!);
      const name = nameById.get(id);
      assert.ok(name !== undefined, `${where}: the tab's SVG has node "${id}", its model does not`);
      return name;
    })
    .sort();
}

/** The node titles of a standalone SVG, sorted. The root's own title carries an id and is not one. */
function standaloneNodeNames(svg: string): string[] {
  return [...svg.matchAll(/<title>([^<]*)<\/title>/g)]
    .map(([, title]) => unescapeXml(title!))
    .sort();
}

interface Surfaces {
  readonly tab: DiagramView;
  readonly exportStatus: number;
  readonly exportSvg: string;
  readonly cli: ReturnType<typeof visualise>;
}

/** Draws one fixture in one state through each of the three functions. */
async function drawEverywhere(name: string, state: State): Promise<Surfaces> {
  const fixture = readFixture(name);
  const spec = toSpecJson(loadFixture(name));
  const network = normalizeNetwork(fixture.network);
  const { address } = fixture;
  const expand = state.expand.join(',');

  __resetDiagramViewCache();
  const tab = drawContractDiagram({
    handle: HANDLE,
    address,
    network,
    spec,
    calls: null,
    mutability: null,
    expand: expand || null,
  });

  const deps: DiagramExportDeps = {
    attribute: async () => ({
      status: 'attributed',
      source: 'database',
      contract: {
        address,
        network,
        wasmHash: fixture.wasmHash,
        deployerPubkey: '',
        deployTxHash: '',
        deployedAt: '',
      },
    }),
    loadSpec: async () => ({ ok: true, spec, wasmHash: fixture.wasmHash, source: 'memory' }),
  };
  const url = new URL(`https://signet.example/p/${HANDLE}/contract/${address}/diagram.svg`);
  if (expand) url.searchParams.set('expand', expand);
  const response = await exportContractDiagram(new Request(url), { handle: HANDLE, address }, deps);

  const input: VisualiseWithExpand = {
    specJson: spec,
    theme: 'auto',
    address,
    network: fixture.network,
    ...(state.expand.length > 0 && { expand: state.expand }),
  };
  return {
    tab,
    exportStatus: response.status,
    exportSvg: await response.text(),
    cli: visualise(input),
  };
}

/** What the export did, for a failure message. It refuses only a diagram that is too large. */
function exportOutcome(status: number): string {
  if (status === 200) return 'draws it (HTTP 200)';
  if (status === 422) return 'refuses it as too-large (HTTP 422)';
  return `answers HTTP ${status}`;
}

for (const name of fixtureNames) {
  for (const state of statesOf(loadFixture(name))) {
    const where = `${name}, ${state.label}`;

    test(`${where}: the tab, the export and visualise() decide alike and draw the same nodes`, async () => {
      const { tab, exportStatus, exportSvg, cli } = await drawEverywhere(name, state);
      const decided = tab.decision.kind;

      assert.ok(
        exportStatus === (decided === 'too-large' ? 422 : 200) && cli.decision.kind === decided,
        `${where}: the surfaces decide differently. ` +
          `The Diagram tab decides ${decided}, ` +
          `the SVG export ${exportOutcome(exportStatus)}, ` +
          `visualise() decides ${cli.decision.kind}.`,
      );
      if (decided !== 'draw') return;

      const drawn = tabNodeNames(tab, where);
      assert.equal(
        drawn.length,
        tab.model.nodes.length,
        `${where}: the tab's SVG lacks some nodes`,
      );
      assert.deepEqual(
        standaloneNodeNames(exportSvg),
        drawn,
        `${where}: the SVG export and the Diagram tab draw different nodes`,
      );
      assert.deepEqual(
        standaloneNodeNames(cli.svg),
        drawn,
        `${where}: visualise() and the Diagram tab draw different nodes`,
      );
    });
  }
}

// Every fixture small enough to draw without collapsing would agree on a tree
// where only the tab collapses. The comparison above means something only
// while a committed fixture is drawn with collapsed groups, and while
// expanding one changes what is drawn.
test('the fixtures include a contract that is drawn only because its groups collapse', async () => {
  let collapsing = 0;
  let changedByExpanding = 0;
  for (const name of fixtureNames) {
    const [collapsed, expanded] = statesOf(loadFixture(name));
    const view = (await drawEverywhere(name, collapsed!)).tab;
    if (view.decision.kind !== 'draw' || !view.model.nodes.some((n) => n.collapsed)) continue;
    collapsing++;
    if (!expanded) continue;
    const wider = (await drawEverywhere(name, expanded)).tab;
    if (wider.model.nodes.length > view.model.nodes.length) changedByExpanding++;
  }
  assert.ok(collapsing >= 1, 'no committed fixture is drawn with collapsed groups');
  assert.ok(changedByExpanding >= 1, 'expanding the largest group changes no fixture');
});
