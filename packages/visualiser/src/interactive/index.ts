/**
 * @file @signet/visualiser/interactive
 *
 * Framework-free DOM enhancers for rendered contract diagrams. The pure core
 * (`@signet/visualiser`) stays DOM-free; this entry is where DOM types are
 * allowed (see `tsconfig.interactive.json`).
 *
 * Landed:
 * - `enhanceDetails` — hover/focus detail card (#500).
 * - `enhanceKeyboard` — keyboard navigation and roving tabindex (#501).
 *
 * Still to come (#502–#505): group collapse/expand, search/filter,
 * bounded viewport with zoom and pan, and node permalinks.
 */

export type { DetailsData, EnhanceDetailsOptions, NodeDetails } from './details.ts';
export {
  DEFAULT_GAP,
  DETAILS_CLASSES,
  detailSections,
  enhanceDetails,
  placeCard,
  relatedTo,
} from './details.ts';

export type {
  EdgeRef,
  EnhanceKeyboardOptions,
  NodePosition,
} from './keyboard.ts';
export {
  KEYBOARD_CLASSES,
  KEYBOARD_HINT_TEXT,
  buildNavigationMaps,
  enhanceKeyboard,
  getNodePosition,
  groupNodesIntoColumns,
} from './keyboard.ts';

/**
 * Placeholder for the pan/zoom/selection enhancer that lands in #501–#505.
 * Kept so the package's `./interactive` entry has a stable surface while that
 * work is outstanding; it throws the same way the scaffold did.
 */
export function enhanceInteractive(): never {
  throw new Error('@signet/visualiser interactive enhancer is not implemented yet (see #501–#505)');
}
