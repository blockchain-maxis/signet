import React from 'react';

export interface TocItem {
  readonly title: string;
  readonly href: string;
}

export interface TableOfContentsProps {
  readonly items: readonly TocItem[];
  readonly className?: string;
}

const MONO = { fontFamily: 'var(--font-mono)' } as const;

/**
 * Mobile in-page table of contents rendered as a collapsible `<details>`.
 */
export function TableOfContentsDetails({ items, className }: TableOfContentsProps) {
  if (items.length === 0) return null;

  return (
    <details
      className={`mb-8 rounded border border-[#1f1d19] bg-[#0d0c0a] p-3 text-[13px] ${className ?? ''}`}
      data-testid="toc-details"
    >
      <summary
        className="cursor-pointer font-medium text-[#f5f4ee] hover:text-[#e05a4b] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#e05a4b]"
        style={MONO}
      >
        On this page ({items.length})
      </summary>
      <ul className="mt-3 space-y-2 border-l border-[#1f1d19] pl-3">
        {items.map((item) => (
          <li key={item.href}>
            <a
              href={item.href}
              className="block text-[#8a8779] hover:text-[#f5f4ee] hover:underline"
              style={MONO}
            >
              {item.title}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Desktop in-page table of contents rendered as a sticky sidebar.
 */
export function TableOfContentsSticky({ items, className }: TableOfContentsProps) {
  if (items.length === 0) return null;

  return (
    <aside
      className={`hidden lg:block sticky top-24 self-start max-h-[calc(100vh-6rem)] overflow-y-auto w-52 shrink-0 ${className ?? ''}`}
      data-testid="toc-sticky"
      aria-label="Table of contents"
    >
      <p
        className="text-[10px] uppercase tracking-[0.22em] text-[#8a8779] mb-3"
        style={MONO}
      >
        On this page
      </p>
      <ul className="space-y-2 border-l border-[#1f1d19] pl-3 text-[12px] leading-[1.6]">
        {items.map((item) => (
          <li key={item.href}>
            <a
              href={item.href}
              className="block text-[#8a8779] hover:text-[#f5f4ee] hover:underline transition-colors [overflow-wrap:anywhere]"
              style={MONO}
            >
              {item.title}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}
