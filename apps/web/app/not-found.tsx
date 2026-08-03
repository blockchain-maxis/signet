'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isReservedHandle } from '@signet/types';
import { matchProfileHandle } from '@/lib/profile-path';

export default function NotFound() {
  const pathname = usePathname();
  const handle = matchProfileHandle(pathname);
  // A reserved handle parses as a path but `claim` would reject it on-chain,
  // so it must never be advertised as available.
  const reserved = handle !== null && isReservedHandle(handle);
  const claimable = handle !== null && !reserved;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#0a0908] px-6 text-center text-[#f5f4ee]">
      <p
        className="mb-3 text-[11px] uppercase tracking-[0.26em] text-[#8b1a1a]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        404
      </p>
      <h1 className="text-4xl font-bold tracking-[-0.025em]" style={{ fontFamily: 'var(--font-display)' }}>
        {reserved
          ? `@${handle} is reserved`
          : claimable
            ? `@${handle} hasn't been claimed`
            : 'Not found'}
      </h1>
      <p className="mt-4 max-w-xs text-sm text-[#8a8779]">
        {reserved
          ? 'This name is reserved for a Signet route, so it can’t be claimed.'
          : claimable
            ? 'This handle is available. Claim it and start building your on-chain record.'
            : "That page or handle doesn't exist."}
      </p>
      {claimable && (
        <Link
          href="/#claim"
          className="mt-8 border border-[#8b1a1a] px-6 py-3 text-[11px] uppercase tracking-[0.22em] text-[#f5f4ee] transition-colors hover:bg-[#8b1a1a]"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          Claim @{handle} →
        </Link>
      )}
      <Link
        href="/"
        className="mt-8 text-[11px] uppercase tracking-[0.22em] text-[#8b1a1a] transition-colors hover:text-[#c2410c]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        ← Back to Signet
      </Link>
    </main>
  );
}
