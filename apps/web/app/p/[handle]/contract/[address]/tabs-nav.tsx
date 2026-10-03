'use client';

import Link from 'next/link';
import { useSelectedLayoutSegment } from 'next/navigation';
import { CONTRACT_TABS, contractTabHref } from '@/lib/contract-tabs';

/**
 * The contract page's tab bar (#445). Tabs are real URLs — links, one route
 * segment each — so every tab is linkable, works with JavaScript disabled
 * (this client component still server-renders, active state included), and
 * diagram nodes can deep-link `…/functions#fn-{name}`.
 *
 * Deliberately NOT an ARIA `tablist` (#461): these are page navigations, and
 * `role="tablist"` would promise arrow-key roving focus that links do not
 * have. Semantics are a labelled `<nav>` of links with `aria-current="page"`
 * on the active one. Next's `Link` (still an `<a>`) is used so navigation stays
 * client-side and the layout survives, which is what lets focus move to the
 * new tab's heading (see `TabFocus`).
 * Only the active-tab lookup needs the client hook, which is why this is the
 * one client component in the shell.
 */
export function ContractTabsNav({ handle, address }: { handle: string; address: string }) {
  const segment = useSelectedLayoutSegment();

  return (
    <nav
      aria-label="Contract sections"
      className="flex flex-wrap gap-x-7 gap-y-2 border-b border-[#1f1d19] px-8 pb-0 md:px-14"
    >
      {CONTRACT_TABS.map((tab) => {
        const active = tab.segment === segment;
        return (
          <Link
            key={tab.id}
            href={contractTabHref(handle, address, tab)}
            aria-current={active ? 'page' : undefined}
            className={`-mb-px border-b-2 pb-3 text-[11px] uppercase tracking-[0.22em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908] ${
              active
                ? 'border-[#8b1a1a] text-[#f5f4ee]'
                : 'border-transparent text-[#8a8779] hover:text-[#f5f4ee]'
            }`}
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
