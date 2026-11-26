/**
 * @file Properties of function grouping and collapsing (#954).
 *
 * `group.test.ts` and `collapse.test.ts` check chosen examples. These state
 * what must hold for any contract: no function is ever dropped or drawn
 * twice, and no edge is lost, whatever the function names, the threshold and
 * the expanded groups. #945 was a break of exactly that (two groups that
 * shared a name collapsed into one node), and nothing stated it.
 *
 * Seeded, so a failure reproduces: the seed is fixed and `FC_RUNS` sets the
 * number of cases (default 200), as in `@signet/spec`'s property tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  canonicalExpand,
  collapseGroups,
  functionGroupsOf,
  COLLAPSE_THRESHOLD,
} from './collapse.ts';
import type { ContractGraph, EdgeRole, GraphEdge, GraphEdgeKind, GraphNode } from './graph.ts';
import { groupFunctions, MIN_GROUP_SIZE } from './group.ts';

/** Fixed seed for reproducible CI runs; configurable run count via `FC_RUNS` (default 200). */
const FC_SEED = 0x516e_6574;
const FC_RUNS = Number(process.env.FC_RUNS ?? 200);
const RUN = { seed: FC_SEED, numRuns: FC_RUNS };

// ─── Generators ─────────────────────────────────────────────────────────────

/** The entrypoints `groupFunctions` puts in the lifecycle group whatever their prefix. */
const LIFECYCLE_NAMES = ['__constructor', 'initialize', 'init', 'upgrade', 'version'];

/**
 * Prefixes that recur, so that families of three or more form. `other` and
 * `lifecycle` are also the names of the two synthetic groups, which is the
 * collision #945 was about.
 */
const FAMILY_PREFIXES = ['pool', 'admin', 'get', 'set', 'other', 'lifecycle', 'x', 'a1'];

/** A Soroban-style name: `[a-z][a-z0-9_]{0,20}`. */
const anyName = fc.stringMatching(/^[a-z][a-z0-9_]{0,20}$/);
const familyName = fc
  .tuple(fc.constantFrom(...FAMILY_PREFIXES), fc.stringMatching(/^[a-z0-9_]{0,8}$/))
  .map(([prefix, rest]) => `${prefix}_${rest}`);
const ordinaryName = fc.oneof(
  { weight: 3, arbitrary: familyName },
  { weight: 2, arbitrary: anyName },
);

/**
 * 0 to 80 function names. A contract cannot export one name twice.
 *
 * `size: 'max'` matters: without it fast-check keeps arrays to about ten
 * items, no contract ever passes the collapse threshold, and every property
 * below holds without testing anything.
 */
const functionNames = fc
  .record({
    ordinary: fc.uniqueArray(ordinaryName, { minLength: 0, maxLength: 75, size: 'max' }),
    // Any subset of the five entrypoints: often several, sometimes exactly
    // one, which makes a lifecycle group of a single function.
    lifecycle: fc.subarray(LIFECYCLE_NAMES),
  })
  .chain(({ ordinary, lifecycle }) => {
    const names = [...new Set([...ordinary, ...lifecycle])];
    return fc.shuffledSubarray(names, { minLength: names.length });
  });

const TYPE_NAMES = ['Config', 'Pool', 'Route', 'Step', 'Key', 'Receipt'];

/** Adds one role to the edge `from -> to`, as `buildContractGraph` does: one edge per pair. */
function addRole(edges: Map<string, GraphEdge>, from: string, to: string, role: EdgeRole): void {
  const id = `${from}->${to}`;
  const edge = edges.get(id);
  edges.set(id, {
    id,
    from,
    to,
    kinds: edge?.kinds.includes(role.kind) ? edge.kinds : [...(edge?.kinds ?? []), role.kind],
    roles: [...(edge?.roles ?? []), role],
  });
}

/**
 * A graph over the given functions: some of the types, random edges from
 * functions to types (arguments and returns), and a few from type to type
 * (fields), which collapsing must leave alone.
 */
function graphOf(
  names: readonly string[],
  types: readonly string[],
  uses: readonly (readonly [number, number, boolean])[],
  fields: readonly (readonly [number, number])[],
): ContractGraph {
  const edges = new Map<string, GraphEdge>();
  if (names.length > 0 && types.length > 0) {
    uses.forEach(([f, t, isReturn], n) => {
      const type = types[t % types.length]!;
      const kind: GraphEdgeKind = isReturn ? 'return' : 'arg';
      addRole(edges, `fn:${names[f % names.length]!}`, `type:${type}`, {
        kind,
        path: type,
        ...(isReturn ? {} : { via: `arg${n}` }),
      });
    });
  }
  if (types.length > 1) {
    fields.forEach(([a, b], n) => {
      const from = types[a % types.length]!;
      const to = types[b % types.length]!;
      if (from !== to)
        addRole(edges, `type:${from}`, `type:${to}`, { kind: 'field', path: to, via: `f${n}` });
    });
  }
  const nodes: GraphNode[] = [
    ...names.map((name): GraphNode => ({ id: `fn:${name}`, kind: 'function', name })),
    ...types.map((name): GraphNode => ({
      id: `type:${name}`,
      kind: 'type',
      name,
      typeKind: 'struct',
    })),
  ];
  return { nodes, edges: [...edges.values()], errors: [], events: [], build: undefined };
}

const contractGraph: fc.Arbitrary<ContractGraph> = fc
  .record({
    names: functionNames,
    types: fc.subarray(TYPE_NAMES),
    uses: fc.array(fc.tuple(fc.nat(), fc.nat(), fc.boolean()), { maxLength: 120, size: 'max' }),
    fields: fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 8, size: 'max' }),
  })
  .map(({ names, types, uses, fields }) => graphOf(names, types, uses, fields));

/**
 * Any threshold, or none so that the default applies. Low ones come up often,
 * so that small contracts collapse too: those are the ones with a group of a
 * single function, which must be left as it is.
 */
const threshold = fc.oneof(
  { weight: 2, arbitrary: fc.constant(undefined) },
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 8 }) },
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 80 }) },
);

/**
 * What a URL might ask to expand: every group's name, its `~name` form, and
 * things that are no group at all.
 */
function expandCandidates(graph: ContractGraph): string[] {
  const names = functionGroupsOf(graph).map((g) => g.name);
  return [...new Set([...names, ...names.map((n) => `~${n}`), 'nope', '', '~', 'collapsed:other'])];
}

/** A graph with a threshold and some subset of what could be asked for. */
const collapseCase = contractGraph.chain((graph) =>
  fc.record({
    graph: fc.constant(graph),
    threshold,
    // Nothing asked for is the common URL, and the one that collapses the most.
    asked: fc.oneof(
      { weight: 1, arbitrary: fc.constant<string[]>([]) },
      { weight: 2, arbitrary: fc.subarray(expandCandidates(graph)) },
    ),
  }),
);

// ─── Helpers ────────────────────────────────────────────────────────────────

const functionNamesOf = (graph: ContractGraph): string[] =>
  graph.nodes.filter((n) => n.kind === 'function').map((n) => n.name);

/** Every function a graph stands for: drawn as itself, or as a member of a collapsed node. */
function representedFunctions(graph: ContractGraph): string[] {
  return graph.nodes.flatMap((n) =>
    n.kind !== 'function' ? [] : n.collapsed ? [...n.collapsed.members] : [n.name],
  );
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

// ─── groupFunctions ─────────────────────────────────────────────────────────

test('groupFunctions puts every name in exactly one group, or returns no groups', () => {
  fc.assert(
    fc.property(functionNames, (names) => {
      const groups = groupFunctions(names);
      if (groups.length === 0) return;
      // One group alone is not a grouping: the flat list is drawn instead.
      assert.ok(groups.length >= 2);
      assert.deepEqual(sorted(groups.flatMap((g) => g.functions)), sorted(names));
      for (const group of groups) {
        assert.ok(group.functions.length > 0, `the group ${group.name} is empty`);
        if (group.kind === 'prefix') {
          assert.ok(group.functions.length >= MIN_GROUP_SIZE);
          assert.ok(group.functions.every((name) => name.startsWith(`${group.name}_`)));
        }
      }
      // Two groups may share a name (an `other_*` family beside the catch-all
      // `other`), but never a name and a kind.
      const identities = groups.map((g) => `${g.kind}:${g.name}`);
      assert.equal(new Set(identities).size, identities.length);
    }),
    RUN,
  );
});

test('groupFunctions gives the same groups for any order of the names', () => {
  const shuffled = functionNames.chain((names) =>
    fc.tuple(fc.constant(names), fc.shuffledSubarray(names, { minLength: names.length })),
  );
  fc.assert(
    fc.property(shuffled, ([names, reordered]) => {
      const groups = groupFunctions(names);
      const again = groupFunctions(reordered);
      // The same groups in the same order, with the same members.
      assert.deepEqual(
        again.map((g) => [g.kind, g.name, sorted(g.functions)]),
        groups.map((g) => [g.kind, g.name, sorted(g.functions)]),
      );
      // Only the order inside a group follows the input.
      for (const group of again) {
        const members = new Set(group.functions);
        assert.deepEqual(
          group.functions,
          reordered.filter((name) => members.has(name)),
        );
      }
    }),
    RUN,
  );
});

// ─── collapseGroups ─────────────────────────────────────────────────────────

/** The expand lists a case is checked under: as asked, and as `canonicalExpand` cleans it. */
const expandLists = (c: { graph: ContractGraph; asked: string[] }): string[][] => [
  c.asked,
  canonicalExpand(c.asked, c.graph),
];

test('collapseGroups conserves every function, at any threshold and expand', () => {
  fc.assert(
    fc.property(collapseCase, (c) => {
      for (const expand of expandLists(c)) {
        const collapsed = collapseGroups(c.graph, { threshold: c.threshold, expand });
        // Each function is drawn once: as its own node, or inside one collapsed node.
        assert.deepEqual(sorted(representedFunctions(collapsed)), sorted(functionNamesOf(c.graph)));
        for (const node of collapsed.nodes) {
          if (node.kind !== 'function' || !node.collapsed) continue;
          assert.ok(node.collapsed.members.length > 1, 'a group of one is left as it is');
        }
      }
    }),
    RUN,
  );
});

test('collapseGroups keeps node ids unique and every edge between nodes that exist', () => {
  fc.assert(
    fc.property(collapseCase, (c) => {
      for (const expand of expandLists(c)) {
        const collapsed = collapseGroups(c.graph, { threshold: c.threshold, expand });
        const ids = collapsed.nodes.map((n) => n.id);
        assert.equal(new Set(ids).size, ids.length, 'two nodes share an id');
        const known = new Set(ids);
        for (const edge of collapsed.edges) {
          assert.ok(known.has(edge.from), `${edge.id} starts at a node that is not drawn`);
          assert.ok(known.has(edge.to), `${edge.id} ends at a node that is not drawn`);
        }
        // Types are never collapsed, moved or dropped.
        assert.deepEqual(
          collapsed.nodes.filter((n) => n.kind !== 'function'),
          c.graph.nodes.filter((n) => n.kind !== 'function'),
        );
      }
    }),
    RUN,
  );
});

test('collapseGroups loses no edge: each one maps to exactly one merged edge', () => {
  fc.assert(
    fc.property(collapseCase, (c) => {
      for (const expand of expandLists(c)) {
        const collapsed = collapseGroups(c.graph, { threshold: c.threshold, expand });
        // Where each function's edges now start.
        const standsFor = new Map<string, string>();
        for (const node of collapsed.nodes) {
          if (node.kind !== 'function' || !node.collapsed) continue;
          for (const member of node.collapsed.members) standsFor.set(`fn:${member}`, node.id);
        }
        // What the merged edges must be: the originals, regrouped by where they start.
        const expected = new Map<
          string,
          { from: string; to: string; kinds: string[]; roles: EdgeRole[] }
        >();
        for (const edge of c.graph.edges) {
          const from = standsFor.get(edge.from) ?? edge.from;
          const id = `${from}->${edge.to}`;
          const merged = expected.get(id) ?? { from, to: edge.to, kinds: [], roles: [] };
          for (const kind of edge.kinds) if (!merged.kinds.includes(kind)) merged.kinds.push(kind);
          merged.roles.push(...edge.roles);
          expected.set(id, merged);
        }
        assert.deepEqual(
          collapsed.edges.map((e) => ({ ...e })),
          [...expected].map(([id, merged]) => ({ id, ...merged })),
        );
      }
    }),
    RUN,
  );
});

test('collapseGroups returns the graph itself at or below the threshold', () => {
  fc.assert(
    fc.property(collapseCase, (c) => {
      const functions = functionNamesOf(c.graph).length;
      const limit = Math.max(functions, c.threshold ?? 0);
      for (const expand of expandLists(c)) {
        assert.equal(collapseGroups(c.graph, { threshold: limit, expand }), c.graph);
      }
    }),
    RUN,
  );
});

test('expanding every group gives back a graph equal to the input', () => {
  fc.assert(
    fc.property(contractGraph, threshold, (graph, limit) => {
      const everything = canonicalExpand(expandCandidates(graph), graph);
      assert.deepEqual(collapseGroups(graph, { threshold: limit, expand: everything }), graph);
    }),
    RUN,
  );
});

// ─── canonicalExpand ────────────────────────────────────────────────────────

test('canonicalExpand is idempotent and does not depend on the order asked', () => {
  const reordered = collapseCase.chain((c) =>
    fc.tuple(fc.constant(c), fc.shuffledSubarray(c.asked, { minLength: c.asked.length })),
  );
  fc.assert(
    fc.property(reordered, ([c, shuffled]) => {
      const canonical = canonicalExpand(c.asked, c.graph);
      assert.deepEqual(canonicalExpand(canonical, c.graph), canonical);
      assert.deepEqual(canonicalExpand(shuffled, c.graph), canonical);
      // Asking twice, or as the comma-separated string a URL carries, changes nothing.
      assert.deepEqual(canonicalExpand([...c.asked, ...shuffled], c.graph), canonical);
      assert.deepEqual(canonicalExpand(shuffled.join(','), c.graph), canonical);
      // A URL may carry spaces around a name: `?expand=pool, admin`.
      assert.deepEqual(
        canonicalExpand(
          shuffled.map((name) => ` ${name} `),
          c.graph,
        ),
        canonical,
      );
      assert.deepEqual(canonical, sorted(canonical));
      assert.equal(new Set(canonical).size, canonical.length);
    }),
    RUN,
  );
});

test('canonicalExpand never returns a name that is not a group', () => {
  fc.assert(
    fc.property(collapseCase, (c) => {
      const groups = functionGroupsOf(c.graph);
      for (const key of canonicalExpand(c.asked, c.graph)) {
        // A key is a group's name, or `~name` for one of the two synthetic groups.
        const synthetic = key.startsWith('~');
        const name = synthetic ? key.slice(1) : key;
        assert.ok(
          groups.some((g) => g.name === name && (!synthetic || g.kind !== 'prefix')),
          `${JSON.stringify(key)} is not a group of this graph`,
        );
      }
      // A contract with no groups has nothing to expand, whatever is asked.
      if (groups.length === 0) assert.deepEqual(canonicalExpand(c.asked, c.graph), []);
    }),
    RUN,
  );
});

// ─── The generator itself ───────────────────────────────────────────────────

test('the generated contracts reach the cases these properties are about', () => {
  // A property that only ever sees small contracts passes without testing
  // anything, so count what 200 seeded cases contain. The run count is fixed
  // here, whatever `FC_RUNS` says, so that the floors below mean something.
  const cases = fc.sample(collapseCase, { seed: FC_SEED, numRuns: 200 });
  const count = (holds: (c: (typeof cases)[number]) => boolean) => cases.filter(holds).length;

  const large = count((c) => functionNamesOf(c.graph).length > 25);
  const collapsed = count(
    (c) => collapseGroups(c.graph, { threshold: c.threshold, expand: c.asked }) !== c.graph,
  );
  // Two groups with one name: an `other_*` or `lifecycle_*` family beside the
  // synthetic group of that name, which is what #945 broke on.
  const sharedName = count((c) => {
    const names = functionGroupsOf(c.graph).map((g) => g.name);
    return new Set(names).size < names.length;
  });
  const withEdges = count((c) => c.graph.edges.length > 0);
  // A group of one function in a contract over its threshold, and not asked
  // to be expanded: collapsing must leave that function drawn as itself.
  const loneGroup = count((c) => {
    const over = functionNamesOf(c.graph).length > (c.threshold ?? COLLAPSE_THRESHOLD);
    const asked = new Set(c.asked);
    return (
      over &&
      functionGroupsOf(c.graph).some(
        (g) => g.functions.length === 1 && !asked.has(g.name) && !asked.has(`~${g.name}`),
      )
    );
  });

  assert.ok(large >= 100, `only ${large} of 200 contracts have more than 25 functions`);
  assert.ok(collapsed >= 60, `only ${collapsed} of 200 cases collapse anything`);
  assert.ok(sharedName >= 20, `only ${sharedName} of 200 contracts have two groups with one name`);
  assert.ok(withEdges >= 100, `only ${withEdges} of 200 contracts have an edge`);
  assert.ok(loneGroup >= 3, `only ${loneGroup} of 200 cases could collapse a group of one`);
});
