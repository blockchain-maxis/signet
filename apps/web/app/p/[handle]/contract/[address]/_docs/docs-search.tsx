'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { formatMatchAnnouncement, matchesSearchQuery } from '@/lib/docs/search';

const MONO = { fontFamily: 'var(--font-mono)' } as const;

export interface DocsSearchProps {
  label?: string;
  placeholder?: string;
  itemNoun?: string;
}

function syncUrlQuery(nextQuery: string): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (nextQuery.trim()) {
    url.searchParams.set('q', nextQuery);
  } else {
    url.searchParams.delete('q');
  }
  const nextHref = `${url.pathname}${url.search}${url.hash}`;
  const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextHref !== currentHref) {
    window.history.replaceState(null, '', nextHref);
  }
}

/**
 * Client-side filter across rendered functions, types, and errors (#479).
 *
 * - Filters `[data-search-text]` items in the enclosing `[data-testid^="slot-"]`
 *   section case-insensitively by name, argument/field name, type name, and doc text.
 * - Announces the match count through a polite `aria-live` status region.
 * - `/` focuses the input and `Esc` clears it.
 * - Reflects the query in `?q=` so a filtered view can be shared.
 * - Hidden via `<noscript>` when JavaScript is disabled while server-rendering
 *   in place when JavaScript is enabled so hydration causes zero layout shift.
 */
export function DocsSearch({
  label = 'Filter items',
  placeholder = 'Filter by name, argument, type, or doc (/)',
  itemNoun = 'items',
}: DocsSearchProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const unusedInitialOpenRef = useRef<boolean | null>(null);

  const [query, setQuery] = useState('');
  const [counts, setCounts] = useState<{ matched: number; total: number }>({ matched: 0, total: 0 });

  const applyFilter = useCallback((rawQuery: string) => {
    const slot = containerRef.current?.closest<HTMLElement>('section[data-testid^="slot-"]');
    if (!slot) return;

    const trimmed = rawQuery.trim();
    const isFiltering = trimmed.length > 0;
    const items = Array.from(slot.querySelectorAll<HTMLElement>('[data-search-text]'));

    let matched = 0;
    for (const item of items) {
      const searchText = item.getAttribute('data-search-text') ?? '';
      const isMatch = !isFiltering || matchesSearchQuery(searchText, trimmed);
      item.hidden = !isMatch;
      if (isMatch) matched++;
    }

    // Toggle constructor wrapper when filtering functions
    const ctorWrapper = slot.querySelector<HTMLElement>('[data-testid="function-constructor"]');
    if (ctorWrapper) {
      const ctorItem = ctorWrapper.querySelector<HTMLElement>('[data-search-text]');
      ctorWrapper.hidden = Boolean(isFiltering && ctorItem?.hidden);
    }

    // Toggle used-types wrapper when filtering types
    const usedTypes = slot.querySelector<HTMLElement>('[data-testid="used-types"]');
    if (usedTypes) {
      const anyVisible = Array.from(usedTypes.querySelectorAll<HTMLElement>('[data-search-text]')).some(
        (el) => !el.hidden,
      );
      usedTypes.hidden = isFiltering && !anyVisible;
    }

    // Expand unused-types <details> automatically when an unused type matches the filter
    const unusedDetails = slot.querySelector<HTMLDetailsElement>('details[data-testid="unused-types"]');
    if (unusedDetails) {
      if (unusedInitialOpenRef.current === null) {
        unusedInitialOpenRef.current = unusedDetails.open;
      }
      const anyVisible = Array.from(
        unusedDetails.querySelectorAll<HTMLElement>('[data-search-text]'),
      ).some((el) => !el.hidden);
      if (isFiltering) {
        unusedDetails.hidden = !anyVisible;
        if (anyVisible) unusedDetails.open = true;
      } else {
        unusedDetails.hidden = false;
        unusedDetails.open = unusedInitialOpenRef.current;
      }
    }

    // Toggle error tables and error-list section when filtering errors
    const errorTables = Array.from(slot.querySelectorAll<HTMLElement>('[data-testid="error-table"]'));
    for (const table of errorTables) {
      const anyVisible = Array.from(table.querySelectorAll<HTMLElement>('[data-testid="error-row"]')).some(
        (row) => !row.hidden,
      );
      table.hidden = isFiltering && !anyVisible;
    }
    const errorList = slot.querySelector<HTMLElement>('[data-testid="error-list"]');
    if (errorList && errorTables.length > 0) {
      const anyTableVisible = errorTables.some((table) => !table.hidden);
      errorList.hidden = isFiltering && !anyTableVisible;
    }

    setCounts({ matched, total: items.length });
  }, []);

  const updateQuery = useCallback(
    (next: string) => {
      setQuery(next);
      syncUrlQuery(next);
      applyFilter(next);
    },
    [applyFilter],
  );

  // Hydrate initial `?q=` from the URL on mount and listen to browser back/forward
  useEffect(() => {
    const readFromUrl = () => {
      const params = new URLSearchParams(window.location.search);
      const initial = params.get('q') ?? '';
      setQuery(initial);
      applyFilter(initial);
    };
    readFromUrl();
    window.addEventListener('popstate', readFromUrl);
    return () => window.removeEventListener('popstate', readFromUrl);
  }, [applyFilter]);

  // Global `/` to focus and `Esc` to clear
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target?.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === 'Escape') {
        if (query !== '') {
          e.preventDefault();
          updateQuery('');
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [query, updateQuery]);

  const isFiltering = query.trim().length > 0;

  return (
    <div ref={containerRef} data-docs-search data-testid="docs-search" className="mb-8">
      <noscript>
        <style>{`[data-docs-search] { display: none !important; }`}</style>
      </noscript>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="relative min-w-0 flex-1 max-w-md">
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => updateQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                updateQuery('');
              }
            }}
            placeholder={placeholder}
            aria-label={label}
            data-testid="docs-search-input"
            className="w-full min-h-11 rounded border border-[#1f1d19] bg-[#0e0d0b] px-3.5 py-2 pr-10 text-[13px] text-[#f5f4ee] placeholder-[#5e5b51] transition-colors focus:border-[#e05a4b] focus:outline-none focus:ring-1 focus:ring-[#e05a4b] [&::-webkit-search-cancel-button]:hidden"
            style={MONO}
          />
          {isFiltering ? (
            <button
              type="button"
              onClick={() => {
                updateQuery('');
                inputRef.current?.focus();
              }}
              aria-label="Clear filter"
              data-testid="docs-search-clear"
              className="absolute right-0 top-0 flex h-11 w-11 min-h-11 min-w-11 items-center justify-center text-[11px] text-[#8a8779] hover:text-[#f5f4ee] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b]"
              style={MONO}
            >
              Esc
            </button>
          ) : (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 border border-[#1f1d19] bg-[#141310] px-1.5 py-0.5 text-[10px] text-[#8a8779]"
              style={MONO}
            >
              /
            </span>
          )}
        </div>

        <span
          role="status"
          aria-live="polite"
          data-testid="docs-search-count"
          className="text-[12px] text-[#8a8779] tabular-nums"
          style={MONO}
        >
          {isFiltering ? formatMatchAnnouncement(counts.matched, counts.total, itemNoun) : ''}
        </span>
      </div>

      {isFiltering && counts.matched === 0 && (
        <p
          className="mt-6 text-[13px] leading-[1.7] text-[#8a8779]"
          style={MONO}
          data-testid="docs-search-empty"
        >
          No matching {itemNoun} for &ldquo;{query.trim()}&rdquo;.
        </p>
      )}
    </div>
  );
}
