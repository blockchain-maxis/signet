/**
 * Abstract contract graph (E-02, §2.2 of docs/CONTRACT_VISUALISER_DESIGN.md).
 *
 * Before anything is positioned, a decoded spec becomes a graph: one node per
 * function, one per user-defined type (struct, union, enum), and directed
 * edges from a function to every type in its signature and from a type to
 * every type its fields or union arms contain. Soroban wraps references in
 * `Option`, `Vec`, `Map`, `Result` and tuples, so each reference is unwrapped
 * recursively to reach the `named` types underneath.
 *
 * Errors and events are deliberately not nodes (design §2.2): they connect to
 * everything or nothing. They ride alongside, untouched, for the list panels.
 *
 * The builder is pure and deterministic. Node order follows spec order
 * (functions, then types, then any `missing` placeholders in the order they
 * were first met) and edge order follows discovery order, so the same spec
 * always yields a deep-equal graph.
 */

import { buildSpecViews, xdrText } from '@signet/spec';
import type {
  ContractBuild,
  ContractSpec,
  SpecErrorCase,
  SpecEvent,
  SpecField,
  SpecType,
  TypeRef,
} from '@signet/spec';

/** Where a reference sits relative to the edge's source node. */
export type GraphEdgeKind = 'arg' | 'return' | 'field';

/** A contract function. Id: `fn:<name>`. */
export interface FunctionNode {
  readonly id: string;
  readonly kind: 'function';
  readonly name: string;
}

/** A user-defined struct, union or enum. Id: `type:<name>`. */
export interface TypeNode {
  readonly id: string;
  readonly kind: 'type';
  readonly name: string;
  readonly typeKind: SpecType['kind'];
}

/**
 * A reference to a type the spec does not define (possible with hand-edited
 * specs). Shares the `type:<name>` id space with {@link TypeNode}.
 */
export interface MissingNode {
  readonly id: string;
  readonly kind: 'missing';
  readonly name: string;
}

export type GraphNode = FunctionNode | TypeNode | MissingNode;

/** One way a source node reaches a target node. */
export interface EdgeRole {
  readonly kind: GraphEdgeKind;
  /**
   * The full type expression the target was reached through, e.g.
   * `Option<Vec<Pool>>`; the bare name when the reference is direct.
   */
  readonly path: string;
  /**
   * The argument or field that carries the reference (`Case.field` for a
   * union arm). Absent for a return value, which has no name.
   */
  readonly via?: string;
}

/**
 * A directed edge. When a source uses the same target more than once there is
 * still a single edge, carrying every role in discovery order.
 */
export interface GraphEdge {
  /** `<from>-><to>`. */
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** Distinct role kinds, in discovery order. */
  readonly kinds: readonly GraphEdgeKind[];
  readonly roles: readonly EdgeRole[];
}

export interface ContractGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** Passed through from the spec unchanged (not nodes, design §2.2). */
  readonly errors: readonly SpecErrorCase[];
  /** Passed through from the spec unchanged (not nodes, design §2.2). */
  readonly events: readonly SpecEvent[];
  /** Passed through from the spec unchanged. */
  readonly build: ContractBuild | undefined;
}

/** Stable node id of a function. */
export function functionNodeId(name: string): string {
  return `fn:${name}`;
}

/** Stable node id of a user-defined type. */
export function typeNodeId(name: string): string {
  return `type:${name}`;
}

/** A type reference as Rust-style text, for edge paths. */
function formatRef(ref: TypeRef): string {
  if (typeof ref === 'string') return ref;
  switch (ref.type) {
    case 'named':
      return ref.name;
    case 'option':
      return `Option<${formatRef(ref.value)}>`;
    case 'vec':
      return `Vec<${formatRef(ref.element)}>`;
    case 'map':
      return `Map<${formatRef(ref.key)}, ${formatRef(ref.value)}>`;
    case 'result':
      return `Result<${formatRef(ref.ok)}, ${formatRef(ref.error)}>`;
    case 'tuple':
      return `(${ref.elements.map(formatRef).join(', ')})`;
    case 'bytes_n':
      return `BytesN<${ref.n}>`;
    case 'unknown':
      return `unknown<${ref.xdrArm}>`;
  }
}

/** Every `named` type a reference mentions, in left-to-right order. */
function namedIn(ref: TypeRef, into: string[]): void {
  if (typeof ref === 'string') return;
  switch (ref.type) {
    case 'named':
      into.push(ref.name);
      return;
    case 'option':
      namedIn(ref.value, into);
      return;
    case 'vec':
      namedIn(ref.element, into);
      return;
    case 'map':
      namedIn(ref.key, into);
      namedIn(ref.value, into);
      return;
    case 'result':
      namedIn(ref.ok, into);
      namedIn(ref.error, into);
      return;
    case 'tuple':
      for (const element of ref.elements) namedIn(element, into);
      return;
    default:
      return;
  }
}

/**
 * Names of every `#[contracterror]` enum. The flattened `errors` view lists
 * cases, so an error enum with no cases would be invisible there; the raw
 * entries are the only complete source. A `Result<_, MyError>` must not turn
 * into a `missing` node just because errors are not nodes.
 */
function errorEnumNames(spec: ContractSpec, errors: readonly SpecErrorCase[]): Set<string> {
  const names = new Set<string>();
  for (const e of errors) names.add(e.enumName);
  for (const entry of spec.entries) {
    if (entry.switch().name === 'scSpecEntryUdtErrorEnumV0') {
      names.add(xdrText(entry.udtErrorEnumV0().name()));
    }
  }
  return names;
}

/** The fields a type's members hang references on, with their edge label. */
function typeMembers(type: SpecType): { via: string; field: SpecField }[] {
  if (type.kind === 'struct') {
    return type.fields.map((field) => ({ via: field.name, field }));
  }
  if (type.kind === 'union') {
    return type.cases.flatMap((c) =>
      c.fields.map((field) => ({ via: `${c.name}.${field.name}`, field })),
    );
  }
  return [];
}

/**
 * The flattened views to draw from. `parseContractSpec` does not populate
 * them yet (its test pins them empty until #430/#431/#432 wire them in), so a
 * spec whose three views are all empty gets them derived from its raw
 * `entries` instead. A populated spec, such as one restored with
 * `fromSpecJson`, is used as it stands.
 */
function viewsOf(spec: ContractSpec): Pick<ContractSpec, 'functions' | 'types' | 'errors'> {
  const empty = spec.functions.length === 0 && spec.types.length === 0 && spec.errors.length === 0;
  return empty && spec.entries.length > 0 ? buildSpecViews(spec.entries) : spec;
}

/**
 * Build the abstract graph of a decoded spec. Pure: no I/O, no WASM decoding,
 * never throws on a dangling reference.
 */
export function buildContractGraph(spec: ContractSpec): ContractGraph {
  const { functions, types, errors } = viewsOf(spec);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  const edgeIndex = new Map<string, number>();
  const errorEnums = errorEnumNames(spec, errors);

  // A duplicated name in a hand-edited spec keeps its first definition, as
  // referencedTypes() in @signet/spec does.
  const addNode = (node: GraphNode): void => {
    if (nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push(node);
  };

  for (const fn of functions) {
    addNode({ id: functionNodeId(fn.name), kind: 'function', name: fn.name });
  }
  for (const type of types) {
    addNode({ id: typeNodeId(type.name), kind: 'type', name: type.name, typeKind: type.kind });
  }

  const addRole = (from: string, ref: TypeRef, role: Omit<EdgeRole, 'path'>): void => {
    const names: string[] = [];
    namedIn(ref, names);
    if (names.length === 0) return;
    const path = formatRef(ref);
    for (const name of names) {
      // Error enums are listed, not drawn (design §2.2).
      if (errorEnums.has(name)) continue;
      const to = typeNodeId(name);
      if (!nodeIds.has(to)) addNode({ id: to, kind: 'missing', name });

      const id = `${from}->${to}`;
      const full: EdgeRole = { ...role, path };
      const at = edgeIndex.get(id);
      if (at === undefined) {
        edgeIndex.set(id, edges.length);
        edges.push({ id, from, to, kinds: [full.kind], roles: [full] });
        continue;
      }
      const edge = edges[at]!;
      const seen = edge.roles.some(
        (r) => r.kind === full.kind && r.path === full.path && r.via === full.via,
      );
      if (seen) continue;
      edges[at] = {
        ...edge,
        kinds: edge.kinds.includes(full.kind) ? edge.kinds : [...edge.kinds, full.kind],
        roles: [...edge.roles, full],
      };
    }
  };

  const walked = new Set<string>();
  for (const fn of functions) {
    const from = functionNodeId(fn.name);
    if (walked.has(from)) continue;
    walked.add(from);
    for (const input of fn.inputs) addRole(from, input.type, { kind: 'arg', via: input.name });
    for (const output of fn.outputs) addRole(from, output, { kind: 'return' });
  }
  for (const type of types) {
    const from = typeNodeId(type.name);
    if (walked.has(from)) continue;
    walked.add(from);
    for (const { via, field } of typeMembers(type)) {
      addRole(from, field.type, { kind: 'field', via });
    }
  }

  return { nodes, edges, errors, events: spec.events, build: spec.build };
}
