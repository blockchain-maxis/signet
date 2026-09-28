import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VISUALISER_VERSION, type DiagramModel } from './index.ts';

test('entry loads and exposes a version', () => {
  assert.match(VISUALISER_VERSION, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});

test('DiagramModel describes nodes and edges', () => {
  const model: DiagramModel = { nodes: [{ id: 'a', label: 'A' }], edges: [] };
  assert.equal(model.nodes.length, 1);
});
