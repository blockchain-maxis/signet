/**
 * The contract page's tab set (#445, docs/CONTRACT_DOCS_DESIGN.md §2.1).
 *
 * One pure table owns the list: the layout's nav renders from it, tests
 * assert on it, and later epics (the diagram's `…/functions#fn-{name}` links,
 * for one) address tabs by `segment` without re-declaring them. `segment` is
 * the App Router child segment — `null` is the index route (Overview), which
 * is also what `useSelectedLayoutSegment()` reports for it.
 *
 * Fragment contract (#450): a function is addressed at `…/functions#fn-{name}`,
 * a type at `…/types#type-{name}` and an error case at
 * `…/types#error-{enum}-{name}`. Build those ids with `fnAnchor`, `typeAnchor`
 * and `errorAnchor` from `lib/docs/anchors.ts`, never by hand, so the tabs that
 * render the targets and the links that point at them share one definition.
 */
export interface ContractTab {
  id: string;
  label: string;
  segment: string | null;
}

export const CONTRACT_TABS: readonly ContractTab[] = [
  { id: 'overview', label: 'Overview', segment: null },
  { id: 'functions', label: 'Functions', segment: 'functions' },
  { id: 'types', label: 'Types', segment: 'types' },
  { id: 'diagram', label: 'Diagram', segment: 'diagram' },
  { id: 'run', label: 'Run locally', segment: 'run' },
  { id: 'activity', label: 'Activity', segment: 'activity' },
];

/** Absolute href for a tab under one contract's base route. */
export function contractTabHref(handle: string, address: string, tab: ContractTab): string {
  const base = `/p/${handle}/contract/${address}`;
  return tab.segment === null ? base : `${base}/${tab.segment}`;
}

/**
 * Absolute href for a tab addressed by its child segment, for callers that
 * carry a segment string rather than a `ContractTab` (the Functions tab for
 * #475's per-function permalink, for one). Reading the segment off
 * `CONTRACT_TABS` keeps the literal in one place: a later epic cannot drift by
 * inventing a `/functions` that the tab bar does not link to.
 */
export function contractTabSegmentHref(
  handle: string,
  address: string,
  segment: string,
): string {
  const tab = CONTRACT_TABS.find((candidate) => candidate.segment === segment);
  if (!tab) throw new RangeError(`No contract tab with segment: ${segment}`);
  return contractTabHref(handle, address, tab);
}

/**
 * Gate for the `signet dev` CLI command (#563). Flip to `true` when the
 * command is released. While `false`, the Run locally tab shows a
 * "not released yet" notice above the command instead of hiding the tab.
 */
export const SIGNET_DEV_RELEASED = false;
