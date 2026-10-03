/**
 * @file @signet/visualiser
 *
 * Type-graph depth policy (#490, design §3 "Inline the type graph one level,
 * link beyond it").
 *
 * A router or AMM has a type graph several levels deep, and drawing all of it
 * produces a hairball. This module decides *which* of those types a diagram
 * draws and which it hands off to the docs: named types up to
 * `LayoutOptions.typeDepth` (default {@link DEFAULT_TYPE_DEPTH}) nesting levels
 * below a function signature are expanded — their member edges are drawn — and
 * every named type beyond that becomes a small `stub` node carrying no outgoing
 * edges, only its name, the count of edges it hides, and the docs anchor that
 * holds its detail. `expandTypes` opens named stubs one level further, which is
 * what the per-type expand control (#502) drives from the URL.
 *
 * Depth counts *named-type nesting*, not `TypeRef` nesting. Wrappers do not add
 * a level: a `Vec<RouteStep>` field is part of the type that holds it, so
 * `RouteStep` sits one level below that type. This matches the rule the design
 * states — "a function's direct argument types are drawn" — and treats
 * `Vec<Option<Pool>>` as an argument type, not two hidden levels.
 *
 * Same as the rest of the core, pure and synchronous: no DOM, no clock, no
 * randomness, and every output order is the spec's declaration order.
 */

import type { ContractSpec, SpecFunction, SpecType, TypeRef } from '@signet/spec';
import type { DiagramEdge, DiagramNode } from './index.ts';

/** Default for `LayoutOptions.typeDepth`: direct argument and return types only. */
export const DEFAULT_TYPE_DEPTH = 1;

/** A stub's hidden-edge count, appended to its label: `RouteStep +3`. */
function hiddenSuffix(hidden: number): string {
  return hidden > 0 ? ` +${hidden}` : '';
}

/**
 * Docs anchor of the section explaining `name`. Soroban identifiers are
 * `[A-Za-z0-9_]`, so this is a prefix, not a slug — the same form the docs
 * renderer emits and #450 specifies.
 */
export function typeAnchor(name: string): string {
  return `type-${name}`;
}

/** Diagram id of the node drawing the user-defined type `name`. */
export function typeNodeId(name: string): string {
  return `type:${name}`;
}

/** Diagram id of the node drawing the contract function `name`. */
export function functionNodeId(name: string): string {
  return `fn:${name}`;
}

/** How deep to inline the type graph before switching to link stubs. */
export interface TypeGraphOptions {
  /**
   * Nesting levels of user-defined types drawn inline, counted from a
   * function's signature. `0` collapses the whole type graph to stubs;
   * `Infinity` expands everything reachable. Defaults to
   * {@link DEFAULT_TYPE_DEPTH}.
   */
  readonly typeDepth?: number;
  /** Types to open to their next level even past `typeDepth`. */
  readonly expandTypes?: readonly string[];
}

/** What one edge of the type graph represents. */
export type TypeGraphEdgeRole = 'input' | 'output' | 'field' | 'case';

/** A node of the depth-limited type graph. */
export interface TypeGraphNode extends DiagramNode {
  /** User-defined type name this node stands for. */
  readonly name: string;
  /** `'stub'` when the node links out to the docs instead of expanding. */
  readonly kind: 'inline' | 'stub';
  /** Nesting level below a function signature; `1` is a direct argument type. */
  readonly depth: number;
  /** Outgoing edges this node hides; `0` for an inline node. */
  readonly hidden: number;
  /** Docs anchor holding this type's detail. */
  readonly anchor: string;
}

/** An edge of the depth-limited type graph. */
export interface TypeGraphEdge extends DiagramEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  /** Which member of `from` produced this edge. */
  readonly role: TypeGraphEdgeRole;
}

/** The depth-limited type graph a layout pass draws. */
export interface TypeGraph {
  /** Nodes in discovery order: signatures first (shallowest depth first). */
  readonly nodes: readonly TypeGraphNode[];
  /** Edges in discovery order, signature edges before member edges. */
  readonly edges: readonly TypeGraphEdge[];
  /**
   * `named` references no type in the spec defines. They are drawn nowhere and
   * link to nothing, exactly as the docs leave them unlinked.
   */
  readonly missing: readonly string[];
}

/** The flattened views the type graph is built from. */
type TypeGraphInput = Pick<ContractSpec, 'functions' | 'types' | 'errors'>;

/** One named type reached through any depth of wrappers. */
function namedIn(ref: TypeRef, visit: (name: string) => void): void {
  if (typeof ref === 'string') return;
  switch (ref.type) {
    case 'named':
      visit(ref.name);
      return;
    case 'option':
      namedIn(ref.value, visit);
      return;
    case 'result':
      namedIn(ref.ok, visit);
      namedIn(ref.error, visit);
      return;
    case 'vec':
      namedIn(ref.element, visit);
      return;
    case 'map':
      namedIn(ref.key, visit);
      namedIn(ref.value, visit);
      return;
    case 'tuple':
      for (const element of ref.elements) namedIn(element, visit);
      return;
    default:
      return;
  }
}

/** One outgoing edge a type would draw if it were expanded. */
interface MemberEdge {
  to: string;
  label: string;
  role: TypeGraphEdgeRole;
}

/** The member edges a type definition declares, in declaration order. */
function membersOf(type: SpecType): MemberEdge[] {
  const out: MemberEdge[] = [];
  if (type.kind === 'struct') {
    for (const field of type.fields) {
      namedIn(field.type, (name) => out.push({ to: name, label: field.name, role: 'field' }));
    }
  } else if (type.kind === 'union') {
    for (const unionCase of type.cases) {
      for (const field of unionCase.fields) {
        namedIn(field.type, (name) =>
          out.push({ to: name, label: `${unionCase.name}.${field.name}`, role: 'case' }),
        );
      }
    }
  }
  // An enum's variants carry discriminants, never types, so it hides nothing.
  return out;
}

/** The edges from a function's signature to the types it names. */
function signatureOf(fn: SpecFunction): MemberEdge[] {
  const out: MemberEdge[] = [];
  for (const input of fn.inputs) {
    namedIn(input.type, (name) => out.push({ to: name, label: input.name, role: 'input' }));
  }
  for (const output of fn.outputs) {
    namedIn(output, (name) => out.push({ to: name, label: 'returns', role: 'output' }));
  }
  return out;
}

/** First definition wins, as in `referencedTypes` — specs should not repeat a name. */
function indexTypes(types: readonly SpecType[]): Map<string, SpecType> {
  const byName = new Map<string, SpecType>();
  for (const type of types) if (!byName.has(type.name)) byName.set(type.name, type);
  return byName;
}

/** A node under construction: a stub only learns its hidden count when reached. */
interface Draft {
  readonly name: string;
  readonly depth: number;
  readonly inline: boolean;
  hidden: number;
}

/**
 * Apply {@link TypeGraphOptions} to a spec: the type nodes to draw, the edges
 * between them, and the signature edges that root them.
 *
 * One node per type name, at the shallowest depth any signature reaches it, so
 * a type used both as a direct argument and deep inside another struct is
 * drawn inline once. Nodes are expanded at most once, which is what makes a
 * recursive type (`struct Node { next: Option<Node> }`) terminate: it yields a
 * self-edge rather than an endless column.
 *
 * Error enums are not `types` and their own section renders them, so a
 * reference to one is neither a node nor `missing` — the same treatment
 * `referencedTypes` gives them.
 */
export function buildTypeGraph(spec: TypeGraphInput, options: TypeGraphOptions = {}): TypeGraph {
  const typeDepth = options.typeDepth ?? DEFAULT_TYPE_DEPTH;
  const forced = new Set(options.expandTypes ?? []);
  const byName = indexTypes(spec.types);
  const errorEnums = new Set<string>();
  for (const error of spec.errors) errorEnums.add(error.enumName);

  const drafts = new Map<string, Draft>();
  const edges: TypeGraphEdge[] = [];
  const missing: string[] = [];

  /** Register a reference at `depth`; keep the shallowest one seen. */
  const visit = (name: string, depth: number): Draft | undefined => {
    if (!byName.has(name)) {
      if (!errorEnums.has(name) && !missing.includes(name)) missing.push(name);
      return undefined;
    }
    const known = drafts.get(name);
    if (known !== undefined) return known;
    const created: Draft = {
      name,
      depth,
      inline: depth <= typeDepth || forced.has(name),
      hidden: 0,
    };
    drafts.set(name, created);
    return created;
  };

  /** Draw a node's member edges, or count the ones its stub hides. */
  const expand = (node: Draft, members: MemberEdge[]): Draft[] => {
    if (!node.inline) {
      let hidden = 0;
      for (const member of members) if (byName.has(member.to)) hidden += 1;
      node.hidden = hidden;
      return [];
    }
    const children: Draft[] = [];
    const from = typeNodeId(node.name);
    for (const member of members) {
      const child = visit(member.to, node.depth + 1);
      if (child === undefined) continue;
      edges.push({ from, to: typeNodeId(child.name), label: member.label, role: member.role });
      children.push(child);
    }
    return children;
  };

  // Column 0 of the graph: the signatures. Every named type they reach is at
  // depth 1, no matter how many wrappers enclose it.
  let frontier: Draft[] = [];
  for (const fn of spec.functions) {
    const from = functionNodeId(fn.name);
    for (const edge of signatureOf(fn)) {
      const child = visit(edge.to, 1);
      if (child === undefined) continue;
      edges.push({ from, to: typeNodeId(child.name), label: edge.label, role: edge.role });
      frontier.push(child);
    }
  }

  // One level per sweep, so a name is classified at its shallowest depth.
  const expanded = new Set<string>();
  while (frontier.length > 0) {
    const next: Draft[] = [];
    for (const node of frontier) {
      if (expanded.has(node.name)) continue;
      expanded.add(node.name);
      const type = byName.get(node.name);
      if (type === undefined) continue;
      next.push(...expand(node, membersOf(type)));
    }
    frontier = next;
  }

  const nodes: TypeGraphNode[] = [];
  for (const draft of drafts.values()) {
    nodes.push({
      id: typeNodeId(draft.name),
      label: draft.inline ? draft.name : `${draft.name}${hiddenSuffix(draft.hidden)}`,
      name: draft.name,
      kind: draft.inline ? 'inline' : 'stub',
      depth: draft.depth,
      hidden: draft.inline ? 0 : draft.hidden,
      anchor: typeAnchor(draft.name),
    });
  }

  return { nodes, edges, missing };
}
