/**
 * @file @signet/visualiser/interactive — live search and filter for diagram nodes (#503).
 *
 * Provides client-side filtering as the user types, dimming non-matching nodes
 * without disrupting diagram layout. Results are announced via an aria-live="polite"
 * region, and pressing Enter focuses the first matching node.
 */

export interface EnhanceFilterOptions {
  /** Root container containing the diagram SVG and optional search controls. */
  container: HTMLElement;
  /** Explicit search input element. If omitted, queries for an input in container. */
  input?: HTMLInputElement;
  /** Explicit live region element with aria-live="polite". If omitted, queries or creates one. */
  liveRegion?: HTMLElement;
  /** Initial query string to apply immediately. */
  initialQuery?: string;
  /** Callback fired after each filter run. */
  onFilter?: (query: string, result: FilterResult) => void;
}

export interface FilterResult {
  readonly query: string;
  readonly totalNodes: number;
  readonly matchingNodes: number;
  readonly totalFunctions: number;
  readonly matchingFunctions: number;
  readonly message: string;
}

export interface FilterController {
  setQuery(query: string): FilterResult;
  getQuery(): string;
  destroy(): void;
}

export const FILTER_CLASSES = {
  dimmed: 'viz-dimmed',
  match: 'viz-match',
} as const;

/**
 * Format the assistive live-region announcement per acceptance criteria.
 */
export function formatFilterAnnouncement(
  matchingFunctions: number,
  totalFunctions: number,
  totalMatches: number,
): string {
  if (totalMatches === 0) {
    return 'No functions or types match';
  }
  return `${matchingFunctions} of ${totalFunctions} functions match`;
}

/**
 * Mount live filtering on a rendered diagram.
 */
export function enhanceFilter(options: EnhanceFilterOptions): FilterController {
  const { container } = options;

  const input =
    options.input ??
    (container.querySelector<HTMLInputElement>('input[type="search"], input[name="q"], .viz-filter-input') ||
      undefined);

  let liveRegion =
    options.liveRegion ??
    (container.querySelector<HTMLElement>('[aria-live="polite"]') || undefined);

  if (!liveRegion && typeof document !== 'undefined') {
    const created = document.createElement('div');
    created.setAttribute('aria-live', 'polite');
    created.className = 'sr-only';
    container.appendChild(created);
    liveRegion = created;
  }

  let currentQuery = '';

  function applyFilter(query: string): FilterResult {
    currentQuery = query;
    const cleanQuery = query.trim().toLowerCase();
    const nodeElements = Array.from(container.querySelectorAll<Element>('[data-node-id]'));

    let totalFunctions = 0;
    let matchingFunctions = 0;
    let matchingNodes = 0;

    for (const node of nodeElements) {
      const id = node.getAttribute('data-node-id') || '';
      const isFunction = id.startsWith('fn:');
      if (isFunction) totalFunctions++;

      if (cleanQuery.length === 0) {
        node.classList.remove(FILTER_CLASSES.dimmed);
        node.classList.remove(FILTER_CLASSES.match);
        matchingNodes++;
        if (isFunction) matchingFunctions++;
        continue;
      }

      const textEl = node.querySelector('text');
      const label = textEl?.textContent || node.textContent || '';
      const isMatch = id.toLowerCase().includes(cleanQuery) || label.toLowerCase().includes(cleanQuery);

      if (isMatch) {
        node.classList.remove(FILTER_CLASSES.dimmed);
        node.classList.add(FILTER_CLASSES.match);
        matchingNodes++;
        if (isFunction) matchingFunctions++;
      } else {
        node.classList.add(FILTER_CLASSES.dimmed);
        node.classList.remove(FILTER_CLASSES.match);
      }
    }

    const message = cleanQuery.length === 0
      ? ''
      : formatFilterAnnouncement(matchingFunctions, totalFunctions, matchingNodes);

    if (liveRegion && cleanQuery.length > 0) {
      liveRegion.textContent = message;
    } else if (liveRegion && cleanQuery.length === 0) {
      liveRegion.textContent = '';
    }

    const result: FilterResult = {
      query,
      totalNodes: nodeElements.length,
      matchingNodes,
      totalFunctions,
      matchingFunctions,
      message,
    };

    options.onFilter?.(query, result);
    return result;
  }

  function handleInput(e: Event) {
    const val = (e.target as HTMLInputElement).value;
    applyFilter(val);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Focus the first matching node
      const firstMatch = container.querySelector<HTMLElement | SVGElement>(
        '[data-node-id]:not(.viz-dimmed)',
      );
      if (firstMatch && typeof firstMatch.focus === 'function') {
        firstMatch.focus();
      }
    }
  }

  if (input) {
    input.addEventListener('input', handleInput);
    input.addEventListener('keydown', handleKeyDown);
  }

  if (options.initialQuery !== undefined) {
    applyFilter(options.initialQuery);
    if (input && input.value !== options.initialQuery) {
      input.value = options.initialQuery;
    }
  }

  return {
    setQuery(q: string) {
      if (input && input.value !== q) {
        input.value = q;
      }
      return applyFilter(q);
    },
    getQuery() {
      return currentQuery;
    },
    destroy() {
      if (input) {
        input.removeEventListener('input', handleInput);
        input.removeEventListener('keydown', handleKeyDown);
      }
    },
  };
}
