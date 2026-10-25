/**
 * @file Vocabulary invariants (#493, backlog E-13).
 *
 * The point of the table is that the distinctions survive greyscale, so most of
 * these tests assert the *combination* of cues is unique, not the colour.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDGE_KIND_ORDER,
  EDGE_VOCABULARY,
  NODE_KIND_ORDER,
  NODE_VOCABULARY,
  WRITE_MARK_ORDER,
  WRITE_MARK_VOCABULARY,
  edgeVocabulary,
  nodeShapeSvg,
  nodeVocabulary,
  renderLegend,
  type NodeKind,
} from './vocabulary.ts';

test('every node kind is described by the table', () => {
  assert.deepEqual(Object.keys(NODE_VOCABULARY).sort(), [...NODE_KIND_ORDER].sort());
});

test('no two node kinds share both a shape and a text prefix', () => {
  const seen = new Map<string, NodeKind>();
  for (const kind of NODE_KIND_ORDER) {
    const vocab = NODE_VOCABULARY[kind];
    const key = `${vocab.shape}|${vocab.prefix}`;
    const other = seen.get(key);
    assert.equal(
      other,
      undefined,
      `${kind} and ${other ?? ''} share shape=${vocab.shape} and prefix=${vocab.prefix}`,
    );
    seen.set(key, kind);
  }
});

test('the four drawn type kinds do not all collapse to one shape', () => {
  const drawn: NodeKind[] = ['function', 'struct', 'union', 'enum'];
  const shapes = new Set(drawn.map((kind) => NODE_VOCABULARY[kind].shape));
  // Not every kind can have its own shape (there are only four shapes and five
  // kinds), but more than one shape must be in play so greyscale still reads.
  assert.ok(shapes.size >= 3);
});

test('only link-outs are dashed outlines: a stub, the collapsed callees and groups', () => {
  for (const kind of NODE_KIND_ORDER) {
    const dashed = NODE_VOCABULARY[kind].shape === 'dashed-outline-rect';
    assert.equal(dashed, kind === 'stub' || kind === 'callees-more' || kind === 'collapsed-group');
  }
});

test('node prefixes are the fixed set', () => {
  assert.deepEqual(
    new Set(NODE_KIND_ORDER.map((kind) => NODE_VOCABULARY[kind].prefix)),
    new Set(['fn', 'group', 'struct', 'union', 'enum', 'stub', 'contract', 'more', 'anchor']),
  );
});

test('every node kind maps to a named design token', () => {
  for (const kind of NODE_KIND_ORDER) {
    assert.match(NODE_VOCABULARY[kind].token, /^[a-zA-Z]+$/);
  }
});

test('every edge kind is described by the table', () => {
  assert.deepEqual(Object.keys(EDGE_VOCABULARY).sort(), [...EDGE_KIND_ORDER].sort());
});

test('no two edge kinds share both a dash pattern and a marker', () => {
  const seen = new Map<string, string>();
  for (const kind of EDGE_KIND_ORDER) {
    const vocab = EDGE_VOCABULARY[kind];
    const key = `${vocab.dash}|${vocab.marker}`;
    const other = seen.get(key);
    assert.equal(
      other,
      undefined,
      `${kind} and ${other ?? ''} share dash=${vocab.dash} and marker=${vocab.marker}`,
    );
    seen.set(key, kind);
  }
});

test('spec-derived edges are solid; observed edges are labelled and never read as spec edges', () => {
  const specMarkers = new Set(
    EDGE_KIND_ORDER.filter((k) => EDGE_VOCABULARY[k].specDerived).map(
      (k) => EDGE_VOCABULARY[k].marker,
    ),
  );
  for (const kind of EDGE_KIND_ORDER) {
    const vocab = EDGE_VOCABULARY[kind];
    if (vocab.specDerived) {
      assert.equal(vocab.dash, 'solid', `${kind} must be solid`);
      assert.equal(vocab.requiresLabel, false);
    } else {
      assert.equal(vocab.requiresLabel, true, `${kind} must carry a label`);
      // Solid only with a marker no spec edge uses (the sandbox's S arrow).
      assert.ok(
        vocab.dash !== 'solid' || !specMarkers.has(vocab.marker),
        `${kind} would read as a spec edge`,
      );
      assert.notEqual(vocab.token, 'edge', `${kind} must not share the spec edges' colour`);
    }
  }
});

test('the argument and return edges differ by arrowhead, not by colour alone', () => {
  assert.equal(EDGE_VOCABULARY.arg.dash, EDGE_VOCABULARY.return.dash);
  assert.notEqual(EDGE_VOCABULARY.arg.marker, EDGE_VOCABULARY.return.marker);
});

test('write marks reserve W/R/? with a filled/outline/none square', () => {
  assert.equal(WRITE_MARK_VOCABULARY.write.glyph, 'W');
  assert.equal(WRITE_MARK_VOCABULARY.write.square, 'filled');
  assert.equal(WRITE_MARK_VOCABULARY.read.glyph, 'R');
  assert.equal(WRITE_MARK_VOCABULARY.read.square, 'outline');
  assert.equal(WRITE_MARK_VOCABULARY.unknown.glyph, '?');
  assert.equal(WRITE_MARK_VOCABULARY.unknown.square, 'none');
  assert.deepEqual(Object.keys(WRITE_MARK_VOCABULARY).sort(), [...WRITE_MARK_ORDER].sort());
});

test('nodeVocabulary and edgeVocabulary are table lookups', () => {
  assert.equal(nodeVocabulary('union'), NODE_VOCABULARY.union);
  assert.equal(edgeVocabulary('observed'), EDGE_VOCABULARY.observed);
});

test('nodeShapeSvg draws each shape with its own element and no hex colour', () => {
  const rect = nodeShapeSvg('rect', 0, 0, 20, 10);
  const rounded = nodeShapeSvg('rounded-rect', 0, 0, 20, 10);
  const notched = nodeShapeSvg('notched-rect', 0, 0, 20, 10);
  const dashed = nodeShapeSvg('dashed-outline-rect', 0, 0, 20, 10);

  assert.match(rect, /^<rect/);
  assert.match(rounded, /rx="6"/);
  assert.match(notched, /^<path/);
  assert.match(dashed, /stroke-dasharray="5 3"/);
  assert.match(dashed, /fill="none"/);
  for (const svg of [rect, rounded, notched, dashed]) {
    assert.ok(!/#[0-9a-fA-F]/.test(svg), `no hardcoded hex in ${svg}`);
    assert.match(svg, /var\(--viz-/);
  }
});

test('renderLegend lists only the node and edge kinds actually drawn', () => {
  const svg = renderLegend(['function', 'struct', 'arg']);

  assert.ok(svg.includes('data-node-kind="function"'));
  assert.ok(svg.includes('data-node-kind="struct"'));
  assert.ok(svg.includes('data-edge-kind="arg"'));
  assert.ok(!svg.includes('data-node-kind="union"'));
  assert.ok(!svg.includes('data-node-kind="enum"'));
  assert.ok(!svg.includes('data-node-kind="stub"'));
  assert.ok(!svg.includes('data-edge-kind="return"'));
  assert.ok(!svg.includes('data-edge-kind="field"'));
  assert.ok(!svg.includes('data-edge-kind="observed"'));
});

test('renderLegend is deterministic and ignores duplicates and unknown kinds', () => {
  const a = renderLegend(['struct', 'function', 'arg', 'struct', 'not-a-kind' as NodeKind]);
  const b = renderLegend(['arg', 'function', 'struct']);
  assert.equal(a, b);
});

test('renderLegend shows a node prefix text cue for every node kind', () => {
  const svg = renderLegend(NODE_KIND_ORDER);
  for (const kind of NODE_KIND_ORDER) {
    const prefix = NODE_VOCABULARY[kind].prefix;
    assert.ok(
      svg.includes(`data-node-prefix="${prefix}"`),
      `legend must show the ${prefix} prefix`,
    );
  }
});

test('renderLegend carries the edge dash and marker attributes from the table', () => {
  const svg = renderLegend(EDGE_KIND_ORDER);
  for (const kind of EDGE_KIND_ORDER) {
    const vocab = EDGE_VOCABULARY[kind];
    assert.ok(
      svg.includes(
        `data-edge-kind="${kind}" data-edge-dash="${vocab.dash}" data-edge-marker="${vocab.marker}"`,
      ),
    );
  }
});

test('renderLegend emits marker defs only for markers it uses', () => {
  const nodesOnly = renderLegend(['function']);
  assert.ok(!nodesOnly.includes('<marker'));

  const fieldOnly = renderLegend(['field']);
  assert.ok(!fieldOnly.includes('<marker'), 'field edges use no marker');

  const withReturn = renderLegend(['return']);
  assert.ok(withReturn.includes('marker id="viz-legend-open-arrow"'));
  assert.ok(!withReturn.includes('filled-arrow'));
});

test('renderLegend can prefix marker ids so two legends do not collide', () => {
  const svg = renderLegend(['arg', 'return'], { idPrefix: 'left' });
  assert.ok(svg.includes('marker id="left-filled-arrow"'));
  assert.ok(svg.includes('marker id="left-open-arrow"'));
  assert.ok(svg.includes('url(#left-open-arrow)'));
});

test('renderLegend omits write marks unless a phase-2 overlay asks for them', () => {
  assert.ok(!renderLegend(NODE_KIND_ORDER).includes('data-write-mark'));
  assert.ok(!renderLegend(EDGE_KIND_ORDER).includes('data-write-mark'));

  const phase2 = renderLegend(['write', 'read', 'unknown']);
  assert.ok(phase2.includes('data-write-mark="write" data-write-square="filled"'));
  assert.ok(phase2.includes('data-write-mark="read" data-write-square="outline"'));
  assert.ok(phase2.includes('data-write-mark="unknown" data-write-square="none"'));
  assert.ok(phase2.includes('data-write-glyph="W"'));
  assert.ok(phase2.includes('data-write-glyph="R"'));
  assert.ok(phase2.includes('data-write-glyph="?"'));
});

test('every legend entry sits on its own row', () => {
  const svg = renderLegend([...NODE_KIND_ORDER, ...EDGE_KIND_ORDER, ...WRITE_MARK_ORDER]);
  const ys = [
    ...svg.matchAll(/data-(?:node-kind|edge-label|write-label)="[^"]+"[^>]* y="(\d+)"/g),
  ].map((match) => match[1]);
  assert.equal(
    ys.length,
    NODE_KIND_ORDER.length + EDGE_KIND_ORDER.length + WRITE_MARK_ORDER.length,
  );
  assert.equal(new Set(ys).size, ys.length, `legend rows share a y coordinate: ${ys.join(', ')}`);
});

test('the W glyph is drawn in the ground colour so it shows on a filled square', () => {
  assert.match(renderLegend(['write']), /data-write-mark="write"[^>]*fill="var\(--viz-ground\)"/);
});

test('renderLegend uses only design tokens — no hardcoded colours', () => {
  const svg = renderLegend([...NODE_KIND_ORDER, ...EDGE_KIND_ORDER, ...WRITE_MARK_ORDER]);
  assert.ok(!/#[0-9a-fA-F]/.test(svg), `legend must not name a hex colour: ${svg}`);
  assert.match(svg, /var\(--viz-/);
});

test('renderLegend marks itself for assistive technology', () => {
  const svg = renderLegend(['function', 'arg']);
  assert.match(svg, /role="group"/);
  assert.match(svg, /aria-label="Diagram legend"/);
  assert.match(svg, /<title>Diagram legend<\/title>/);
});

test('nodeShapeSvg escapes nothing user-supplied', () => {
  // The shape helper only takes fixed enum values; this pins that it never
  // starts emitting arbitrary text that would need escaping.
  assert.ok(!nodeShapeSvg('rect', 0, 0, 10, 10).includes('<text'));
});
