import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalDiagramState,
  collapsedGroupsFor,
  diagramNamesFromSpec,
  diagramStateHref,
  parseDiagramState,
  toggleGroup,
  type DiagramNames,
} from './diagram-state.ts';

const names: DiagramNames = {
  groups: ['admin', 'lifecycle', 'pool'],
  types: ['Pool', 'Route'],
};

test('valid names survive; order is canonical', () => {
  const state = parseDiagramState(new URLSearchParams('expand=pool,admin&types=Route,Pool'), names);
  assert.deepEqual(state, {
    expand: ['admin', 'pool'],
    types: ['Pool', 'Route'],
  });
});

test('unknown and malformed names are ignored, never echoed', () => {
  const state = parseDiagramState(
    new URLSearchParams('expand=%3Cscript%3E,pool,missing&types=NotAType,%22Route'),
    names,
  );
  assert.deepEqual(state.expand, ['pool']);
  assert.deepEqual(state.types, []);
  const href = diagramStateHref('/diagram', state);
  assert.equal(href, '/diagram?expand=pool');
  assert.doesNotMatch(href, /script|missing|NotAType/);
});

test('permuted parameters share one canonical key', () => {
  const first = parseDiagramState(new URLSearchParams('expand=pool,admin&types=Route,Pool'), names);
  const second = parseDiagramState(
    new URLSearchParams('expand=admin,pool&types=Pool,Route'),
    names,
  );
  assert.equal(canonicalDiagramState(first), canonicalDiagramState(second));
  assert.equal(canonicalDiagramState(first), 'expand=admin,pool&types=Pool,Route');
});

test('an absent or empty parameter gives the empty state', () => {
  assert.deepEqual(parseDiagramState(new URLSearchParams(''), names), {
    expand: [],
    types: [],
  });
  assert.deepEqual(parseDiagramState(new URLSearchParams('expand=&types='), names), {
    expand: [],
    types: [],
  });
});

test('Next searchParams arrays are accepted and deduplicated', () => {
  const state = parseDiagramState({ expand: ['pool', 'admin'], types: ['Pool'] }, names);
  assert.deepEqual(state.expand, ['admin', 'pool']);
  assert.deepEqual(state.types, ['Pool']);
});

test('toggling a group adds or removes it and keeps the list sorted', () => {
  const empty = parseDiagramState(new URLSearchParams(''), names);
  const pool = toggleGroup(empty, 'pool');
  const both = toggleGroup(pool, 'admin');
  assert.deepEqual(both.expand, ['admin', 'pool']);
  assert.deepEqual(toggleGroup(both, 'pool').expand, ['admin']);
});

test('a link omits empty parameters and encodes names', () => {
  const empty = parseDiagramState(new URLSearchParams(''), names);
  assert.equal(
    diagramStateHref('/p/alice/contract/C1/diagram', empty),
    '/p/alice/contract/C1/diagram',
  );
  assert.equal(
    diagramStateHref('/d', { expand: ['admin', 'pool'], types: ['Pool'] }),
    '/d?expand=admin,pool&types=Pool',
  );
});

test('groups collapse only above the threshold, except the expanded ones', () => {
  const state = parseDiagramState(new URLSearchParams('expand=pool'), names);
  assert.deepEqual(collapsedGroupsFor(names, state, 10, 25), []);
  assert.deepEqual(collapsedGroupsFor(names, state, 26, 25), ['admin', 'lifecycle']);
});

test('names come from groupFunctions, so a flat contract exposes no group control', () => {
  const diagramNames = diagramNamesFromSpec({
    functions: [{ name: 'claim' }, { name: 'resolve' }],
    types: [{ name: 'Record' }],
  });
  assert.deepEqual(diagramNames, { groups: [], types: ['Record'] });
});
