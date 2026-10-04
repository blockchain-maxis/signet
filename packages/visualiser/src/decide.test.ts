import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_NODES, MIN_EDGES, diagramDecision, type DecidableGraph } from './decide.ts';
import type { DiagramModel } from './index.ts';

function makeModel(): DiagramModel {
  return { nodes: [], edges: [] };
}

/**
 * The identity registry: 8 functions, 0 types, 0 spec-derived edges.
 * Per design §3, it should be too-simple because the docs already say everything.
 */
function registryGraph(): DecidableGraph {
  return {
    nodes: [
      { id: 'fn:claim', label: 'claim', kind: 'function' },
      { id: 'fn:release', label: 'release', kind: 'function' },
      { id: 'fn:transfer_handle', label: 'transfer_handle', kind: 'function' },
      { id: 'fn:admin_revoke', label: 'admin_revoke', kind: 'function' },
      { id: 'fn:set_admin', label: 'set_admin', kind: 'function' },
      { id: 'fn:resolve', label: 'resolve', kind: 'function' },
      { id: 'fn:resolve_many', label: 'resolve_many', kind: 'function' },
      { id: 'fn:lookup', label: 'lookup', kind: 'function' },
    ],
    edges: [],
  };
}

/**
 * A mid-size contract with functions, types, and edges between them.
 * The `types_zoo` fixture covers many type arms; we model a representative
 * graph that has more than MIN_EDGES but fewer than MAX_NODES nodes.
 */
function midSizeGraph(): DecidableGraph {
  return {
    nodes: [
      { id: 'fn:swap', label: 'swap', kind: 'function' },
      { id: 'fn:add_liquidity', label: 'add_liquidity', kind: 'function' },
      { id: 'fn:remove_liquidity', label: 'remove_liquidity', kind: 'function' },
      { id: 'fn:get_reserves', label: 'get_reserves', kind: 'function' },
      { id: 'type:Pool', label: 'Pool', kind: 'type' },
      { id: 'type:Token', label: 'Token', kind: 'type' },
      { id: 'type:Reserves', label: 'Reserves', kind: 'type' },
    ],
    edges: [
      { from: 'fn:swap', to: 'type:Pool', kind: 'arg', path: 'Pool' },
      { from: 'fn:swap', to: 'type:Token', kind: 'arg', path: 'Token' },
      { from: 'fn:add_liquidity', to: 'type:Pool', kind: 'arg', path: 'Pool' },
      { from: 'fn:add_liquidity', to: 'type:Token', kind: 'arg', path: 'Token' },
      { from: 'fn:get_reserves', to: 'type:Reserves', kind: 'return', path: 'Reserves' },
    ],
  };
}

/**
 * A synthetic graph with 120 nodes (exceeds MAX_NODES = 60).
 */
function largeGraph(): DecidableGraph {
  const nodes: unknown[] = [];
  const edges: unknown[] = [];

  // 20 functions
  for (let i = 0; i < 20; i++) {
    nodes.push({ id: `fn:f${i}`, label: `f${i}`, kind: 'function' });
  }
  // 100 types
  for (let i = 0; i < 100; i++) {
    nodes.push({ id: `type:T${i}`, label: `T${i}`, kind: 'type' });
  }
  // Some edges so it's not too-simple
  for (let i = 0; i < 20; i++) {
    edges.push({
      from: `fn:f${i}`,
      to: `type:T${i % 100}`,
      kind: 'arg',
      path: `T${i % 100}`,
    });
  }

  return { nodes, edges };
}

/**
 * The registry with a synthetic write overlay (phase 2 data).
 * Even though it has zero spec-derived edges, the overlay provides
 * read/write marks, so it should draw.
 */
function registryWithOverlay(): DecidableGraph {
  return {
    nodes: [
      { id: 'fn:claim', label: 'claim', kind: 'function' },
      { id: 'fn:release', label: 'release', kind: 'function' },
      { id: 'fn:transfer_handle', label: 'transfer_handle', kind: 'function' },
      { id: 'fn:admin_revoke', label: 'admin_revoke', kind: 'function' },
      { id: 'fn:set_admin', label: 'set_admin', kind: 'function' },
      { id: 'fn:resolve', label: 'resolve', kind: 'function' },
      { id: 'fn:resolve_many', label: 'resolve_many', kind: 'function' },
      { id: 'fn:lookup', label: 'lookup', kind: 'function' },
    ],
    edges: [
      // Simulated overlay edge: a write mark on `claim` is not a spec-derived
      // edge, but the test here checks that any edge (including overlay) makes
      // it draw. The current logic only counts spec edges, so this test will
      // fail until phase-2 overlay integration. We leave it as a future
      // marker and note it in the test comment.
      { from: 'fn:claim', to: 'type:Overlay', kind: 'arg', path: 'Overlay' },
    ],
  };
}

test('registry fixture (8 functions, 0 edges) gives too-simple', () => {
  const decision = diagramDecision(registryGraph(), makeModel());
  assert.deepEqual(decision, { kind: 'too-simple', reason: 'no spec-derived edges to draw' });
});

test('mid-size fixture gives draw', () => {
  const decision = diagramDecision(midSizeGraph(), makeModel());
  assert.deepEqual(decision, { kind: 'draw' });
});

test('generated 120-node graph gives too-large', () => {
  const decision = diagramDecision(largeGraph(), makeModel());
  assert.deepEqual(decision, { kind: 'too-large', nodeCount: 120 });
});

test('registry with synthetic write overlay gives draw', () => {
  // This test documents the intended phase-2 behaviour. The current
  // implementation only counts spec-derived edges, so it will return
  // too-simple. When phase-2 overlays are integrated (#500+), this test
  // should pass with `draw`. For now it records the expected outcome.
  const decision = diagramDecision(registryWithOverlay(), makeModel());
  assert.deepEqual(decision, { kind: 'draw' });
});

test('MAX_NODES and MIN_EDGES are exported as named constants', () => {
  assert.equal(MAX_NODES, 60);
  assert.equal(MIN_EDGES, 0);
});
