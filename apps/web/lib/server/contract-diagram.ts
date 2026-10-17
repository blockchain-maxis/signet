/**
 * @file Server rendering for the Diagram tab (#502).
 *
 * One pure-ish function composes the visualiser for a contract and state:
 * decoded spec → collapsed-group policy → type depth → layout → SVG. The
 * result is cached per `(wasmHash, layoutVersion, state, route)` — and only
 * per those, so permuted `expand`/`types` parameters share one entry because
 * `canonicalDiagramState` sorts them.
 *
 * The cache is in-process and bounded. Layout is deterministic for a
 * `wasmHash` (design §4.2), so a state that has been rendered once does not
 * need the graph or text metrics again. Rendering still happens on the
 * server: the SVG the cache returns is the same bytes a cold request returns,
 * which is what makes the fragment route and the page interchangeable.
 */

import { fromSpecJson, type ContractSpec, type SpecJson } from '@signet/spec';
import {
  COLLAPSE_THRESHOLD,
  LAYOUT_VERSION,
  layoutContractDiagram,
  renderDiagramSvg,
} from '@signet/visualiser';
import type { DiagramNames, DiagramState } from '../diagram-state.ts';
import {
  canonicalDiagramState,
  collapsedGroupsFor,
  diagramStateHref,
  toggleGroup,
} from '../diagram-state.ts';
import { fnAnchor, typeAnchor } from '../docs/anchors.ts';
import { logger } from '../logger.ts';

/** Bumped when the rendered SVG changes without a layout-version bump. */
const DIAGRAM_RENDER_VERSION = 1;

/** Enough states for a large contract's groups without unbounded growth. */
const MAX_CACHE_ENTRIES = 256;

const cache = new Map<string, string>();

/** A diagram request: the decoded spec and the validated URL state. */
export interface ContractDiagramInput {
  /** The loader's full `SpecJson`. */
  readonly spec: SpecJson;
  readonly names: DiagramNames;
  readonly state: DiagramState;
  /** `/p/{handle}/contract/{address}` — sibling tabs hang off this. */
  readonly contractBase: string;
  /** `/p/{handle}/contract/{address}/diagram`. */
  readonly diagramPath: string;
  /** Indexed WASM hash; `null` on the Horizon attribution path. */
  readonly wasmHash: string | null;
  readonly title: string;
}

export type ContractDiagramResult =
  | { readonly ok: true; readonly svg: string }
  | { readonly ok: false; readonly reason: 'invalid_spec' | 'render_failed' };

function cacheKey(input: ContractDiagramInput): string {
  return [
    input.wasmHash ?? input.spec.wasmHash ?? 'no-hash',
    LAYOUT_VERSION,
    DIAGRAM_RENDER_VERSION,
    input.contractBase,
    canonicalDiagramState(input.state),
  ].join('|');
}

/** Test seam: drop every cached diagram. */
export function clearDiagramCache(): void {
  cache.clear();
}

/** Test seam: how many states are cached. */
export function diagramCacheSize(): number {
  return cache.size;
}

function remember(key: string, svg: string): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, svg);
}

/**
 * Render the diagram for one state.
 *
 * Failures are values, not throws: a spec the reader accepted but the
 * visualiser cannot lay out must not turn the tab into a 500. The page and the
 * fragment route render the same fallback for `ok: false`.
 */
export function renderContractDiagram(input: ContractDiagramInput): ContractDiagramResult {
  const key = cacheKey(input);
  const cached = cache.get(key);
  if (cached !== undefined) {
    // Refresh the LRU position.
    cache.delete(key);
    cache.set(key, cached);
    return { ok: true, svg: cached };
  }

  let spec: ContractSpec;
  try {
    spec = fromSpecJson(input.spec);
  } catch {
    return { ok: false, reason: 'invalid_spec' };
  }

  let svg: string;
  try {
    const functionCount = input.spec.functions.length;
    const collapsedGroups = collapsedGroupsFor(
      input.names,
      input.state,
      functionCount,
      COLLAPSE_THRESHOLD,
    );
    // Below the threshold every group is always open, so a collapse control
    // would be a link that changes the URL without changing the picture.
    const canCollapse = functionCount > COLLAPSE_THRESHOLD;
    const model = layoutContractDiagram(spec, {
      collapsedGroups,
      expandTypes: [...input.state.types],
    });
    svg = renderDiagramSvg(model, {
      idPrefix: 'diagram-',
      title: input.title,
      hrefForNode: (nodeId) => {
        if (nodeId.startsWith('fn:')) {
          return `${input.contractBase}/functions#${fnAnchor(nodeId.slice('fn:'.length))}`;
        }
        if (nodeId.startsWith('type:')) {
          return `${input.contractBase}/types#${typeAnchor(nodeId.slice('type:'.length))}`;
        }
        if (nodeId.startsWith('group:')) {
          const group = nodeId.slice('group:'.length);
          return diagramStateHref(input.diagramPath, toggleGroup(input.state, group));
        }
        return null;
      },
      ...(canCollapse
        ? {
            hrefForGroup: (group: { name: string }) =>
              diagramStateHref(input.diagramPath, toggleGroup(input.state, group.name)),
          }
        : {}),
    });
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'contract diagram render failed',
    );
    return { ok: false, reason: 'render_failed' };
  }

  remember(key, svg);
  return { ok: true, svg };
}
