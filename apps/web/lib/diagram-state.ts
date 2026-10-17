/**
 * @file Diagram URL state (#502).
 *
 * The Diagram tab is server-first: `?expand=pool,admin&types=Pool` is parsed
 * on the server, validated against the contract's own names, and rendered into
 * the SVG. Every collapsed group is one link to the URL that expands it, so
 * the diagram works without JavaScript; the client enhancer only swaps the
 * fragment in place.
 *
 * Only names the spec actually defines survive parsing. An unknown name is
 * dropped, which means a hostile `?expand=<script>` can never be echoed back
 * into an href or a label. Surviving names are sorted by code unit, so
 * `?expand=admin,pool` and `?expand=pool,admin` are one cache entry and one
 * canonical URL.
 *
 * Pure: no DOM, no `URLSearchParams` requirement, no I/O. The server page and
 * the fragment route both call this.
 */

import { groupFunctions } from '@signet/visualiser';

/** The names a contract's diagram can toggle. */
export interface DiagramNames {
  /** Function groups from `groupFunctions`; empty when the contract is flat. */
  readonly groups: readonly string[];
  /** User-defined type names that `?types=` may open. */
  readonly types: readonly string[];
}

/**
 * The validated state of one diagram URL.
 *
 * An absent `expand` and an empty one parse the same way. The difference that
 * matters is supplied by the caller: whether the user asked for a specific
 * state at all. `parseDiagramState` always returns the empty state when the
 * parameters are absent or invalid.
 */
export interface DiagramState {
  /** Expanded group names, sorted by code unit. */
  readonly expand: readonly string[];
  /** Expanded type names, sorted by code unit. */
  readonly types: readonly string[];
}

/** Next.js `searchParams` and an URL's search params both fit this. */
export type DiagramQuery =
  | URLSearchParams
  | Readonly<Record<string, string | readonly string[] | undefined>>;

/** The names a decoded spec makes available to the controls. */
export function diagramNamesFromSpec(spec: {
  readonly functions: readonly { readonly name: string }[];
  readonly types: readonly { readonly name: string }[];
}): DiagramNames {
  return {
    groups: groupFunctions(spec.functions.map((fn) => fn.name)).map((group) => group.name),
    types: [...new Set(spec.types.map((type) => type.name))],
  };
}

function read(query: DiagramQuery, key: string): string | readonly string[] | undefined {
  if (query instanceof URLSearchParams) return query.get(key) ?? undefined;
  return query[key];
}

function rawNames(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  const joined = typeof value === 'string' ? value : value.join(',');
  return joined.split(',').map((name) => name.trim());
}

function sortedKnown(value: string | readonly string[] | undefined): string[] {
  const known = rawNames(value);
  return [...new Set(known)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function validAgainst(values: readonly string[], known: ReadonlySet<string>): string[] {
  return values.filter((value) => known.has(value));
}

/** Parse `expand` and `types`, keeping only names the spec defines. */
export function parseDiagramState(query: DiagramQuery, names: DiagramNames): DiagramState {
  const groupNames = new Set(names.groups);
  const typeNames = new Set(names.types);
  return {
    expand: validAgainst(sortedKnown(read(query, 'expand')), groupNames),
    types: validAgainst(sortedKnown(read(query, 'types')), typeNames),
  };
}

/**
 * The canonical cache key for a state: sorted names, always both keys, so
 * permuted parameters cannot create a second entry.
 */
export function canonicalDiagramState(state: DiagramState): string {
  return `expand=${state.expand.join(',')}&types=${state.types.join(',')}`;
}

function encodeList(values: readonly string[]): string {
  return values.map((value) => encodeURIComponent(value)).join(',');
}

/** Add or remove one group, returning the next sorted state. */
export function toggleGroup(state: DiagramState, group: string): DiagramState {
  const has = state.expand.includes(group);
  const expand = has
    ? state.expand.filter((name) => name !== group)
    : [...state.expand, group].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { expand, types: state.types };
}

/**
 * The URL for a state under the Diagram tab. Empty parameters are omitted, so
 * an all-collapsed diagram has a clean base URL and the expanded one names
 * only what it expands.
 */
export function diagramStateHref(basePath: string, state: DiagramState): string {
  const params: string[] = [];
  if (state.expand.length > 0) params.push(`expand=${encodeList(state.expand)}`);
  if (state.types.length > 0) params.push(`types=${encodeList(state.types)}`);
  return params.length === 0 ? basePath : `${basePath}?${params.join('&')}`;
}

/**
 * Groups drawn collapsed. A contract above `threshold` functions starts
 * collapsed except for the groups the reader explicitly expanded. At or below
 * the threshold nothing is collapsed, so a small contract opens fully even if
 * a stale `?expand=` lingers in the URL.
 */
export function collapsedGroupsFor(
  names: DiagramNames,
  state: DiagramState,
  functionCount: number,
  threshold: number,
): string[] {
  if (functionCount <= threshold) return [];
  const expanded = new Set(state.expand);
  return names.groups.filter((group) => !expanded.has(group));
}
