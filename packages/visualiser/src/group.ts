/**
 * @file Group functions by name prefix (#484, design §3).
 *
 * Soroban contracts conventionally namespace their functions (`pool_*`,
 * `admin_*`, `get_*`). Clustering on the prefix turns 40 flat labels into a
 * handful of groups a reader can scan. This is a spec-only heuristic: names
 * in, groups out, no graph or layout dependency.
 */

/** Smallest number of members a name prefix needs to form its own group. */
export const MIN_GROUP_SIZE = 3;

/** Name of the group holding the well-known entrypoints. */
export const LIFECYCLE_GROUP = 'lifecycle';

/** Name of the group holding everything that formed no group of its own. */
export const OTHER_GROUP = 'other';

/** Entrypoints that go in the lifecycle group whatever their prefix. */
const LIFECYCLE_NAMES: ReadonlySet<string> = new Set([
  '__constructor',
  'initialize',
  'init',
  'upgrade',
  'version',
]);

/**
 * One cluster of functions. `kind` tells a real prefix apart from the two
 * synthetic groups, so a contract with an `other_*` family cannot be mistaken
 * for the catch-all.
 */
export interface FunctionGroup {
  /** The shared prefix, or `lifecycle` / `other` for the synthetic groups. */
  readonly name: string;
  readonly kind: 'prefix' | 'lifecycle' | 'other';
  /** Member function names, in the order they appear in the input. */
  readonly functions: readonly string[];
}

/** Code-unit string order: locale-independent, so output is deterministic. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** The text before the first `_`, or `undefined` if there is none to use. */
function prefixOf(name: string): string | undefined {
  const at = name.indexOf('_');
  return at > 0 ? name.slice(0, at) : undefined;
}

/**
 * Groups function names by the text before their first `_`.
 *
 * - A prefix forms a group only with at least {@link MIN_GROUP_SIZE} members.
 * - Well-known entrypoints (`__constructor`, `initialize`, `init`, `upgrade`,
 *   `version`) form the `lifecycle` group whatever their prefix, and do not
 *   count toward any prefix's size.
 * - Everything else (no usable underscore, or a prefix too small to group)
 *   goes to the `other` group.
 * - Groups are ordered by size descending, then by name; functions within a
 *   group keep their input (spec) order.
 * - A contract that ends up with one group or none is left ungrouped: the
 *   result is an empty array and the caller draws the flat list.
 */
export function groupFunctions(names: readonly string[]): FunctionGroup[] {
  const lifecycle: string[] = [];
  const byPrefix = new Map<string, string[]>();

  for (const name of names) {
    if (LIFECYCLE_NAMES.has(name)) {
      lifecycle.push(name);
      continue;
    }
    const prefix = prefixOf(name);
    if (prefix === undefined) continue;
    const members = byPrefix.get(prefix);
    if (members) members.push(name);
    else byPrefix.set(prefix, [name]);
  }

  const groups: FunctionGroup[] = [];
  const grouped = new Set<string>();
  for (const [prefix, members] of byPrefix) {
    if (members.length < MIN_GROUP_SIZE) continue;
    groups.push({ name: prefix, kind: 'prefix', functions: members });
    grouped.add(prefix);
  }

  if (lifecycle.length > 0) {
    groups.push({ name: LIFECYCLE_GROUP, kind: 'lifecycle', functions: lifecycle });
  }

  const other = names.filter((name) => {
    if (LIFECYCLE_NAMES.has(name)) return false;
    const prefix = prefixOf(name);
    return prefix === undefined || !grouped.has(prefix);
  });
  if (other.length > 0) {
    groups.push({ name: OTHER_GROUP, kind: 'other', functions: other });
  }

  if (groups.length <= 1) return [];

  return groups.sort(
    (a, b) =>
      b.functions.length - a.functions.length ||
      compareStrings(a.name, b.name) ||
      compareStrings(a.kind, b.kind),
  );
}
