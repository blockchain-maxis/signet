'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const DASHBOARD_NAV = [
  { href: '/app', label: 'Overview' },
  { href: '/app/profile', label: 'Profile' },
  { href: '/app/wallets', label: 'Wallets' },
  { href: '/app/api-keys', label: 'API keys' },
  { href: '/app/settings', label: 'Settings' },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/app') {
    return pathname === '/app' || pathname === '/app/';
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Dashboard navigation bar (#904).
 * Rendered at every viewport width as a horizontally scrollable row under the
 * top bar (matching the contract tabs pattern in `tabs-nav.tsx`).
 *
 * Tap targets are at least 44px (min-h-11 min-w-11), and the active section
 * is marked with aria-current="page".
 */
export function DashboardNav() {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const nav = navRef.current;
    const activeEl = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !activeEl) return;
    const navRect = nav.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();
    if (activeRect.left < navRect.left) {
      nav.scrollLeft += activeRect.left - navRect.left - 16;
    } else if (activeRect.right > navRect.right) {
      nav.scrollLeft += activeRect.right - navRect.right + 16;
    }
  }, [pathname]);

  return (
    <nav
      ref={navRef}
      aria-label="Dashboard"
      className="flex flex-nowrap gap-x-6 overflow-x-auto border-b border-[#1f1d19] px-8 pb-0 md:gap-x-7 md:px-14"
    >
      {DASHBOARD_NAV.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`inline-flex min-h-11 min-w-11 shrink-0 items-center whitespace-nowrap border-b-2 py-2.5 text-[11px] uppercase tracking-[0.22em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908] ${
              active
                ? 'border-[#8b1a1a] text-[#f5f4ee]'
                : 'border-transparent text-[#8a8779] hover:text-[#f5f4ee]'
            }`}
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
