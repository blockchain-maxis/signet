'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { buildContractNotFound } from '@/lib/contract-not-found';

// Lives in `contract/`, not next to `[address]/layout.tsx`. A not-found
// boundary sits *inside* its own segment's layout (layout > error > loading >
// not-found > page), so one beside the layout could never catch the
// `notFound()` the layout throws for an unattributed contract; the segment
// above can. `useParams` rather than the pathname: the contract route is also
// reached through the subdomain rewrite, where the visible path has no handle.

const LINK =
  'text-[11px] uppercase tracking-[0.22em] text-[#e05a4b] transition-colors hover:text-[#f0806f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908]';

export default function ContractNotFound() {
  const params = useParams<{ handle?: string; address?: string }>();
  const m = buildContractNotFound({ handle: params?.handle, address: params?.address });

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#0a0908] px-6 text-center text-[#f5f4ee]">
      <p
        className="mb-3 text-[11px] uppercase tracking-[0.26em] text-[#e05a4b]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        404
      </p>
      <h1 className="text-4xl font-bold tracking-[-0.025em]" style={{ fontFamily: 'var(--font-display)' }}>
        {m.heading}
      </h1>
      <div className="mt-4 max-w-sm space-y-2 text-sm text-[#8a8779]">
        {m.body.map((sentence) => (
          <p key={sentence}>{sentence}</p>
        ))}
      </div>
      <nav
        aria-label="Where to go instead"
        className="mt-8 flex flex-wrap items-center justify-center gap-x-8 gap-y-4"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {m.profileHref !== null && (
          <Link href={m.profileHref} className={LINK}>
            View @{m.handle}&apos;s profile
          </Link>
        )}
        {m.explorerHref !== null && (
          <a href={m.explorerHref} target="_blank" rel="noopener noreferrer" className={LINK}>
            Look it up on Stellar Expert ↗
          </a>
        )}
        {m.profileHref === null && m.explorerHref === null && (
          <Link href="/" className={LINK}>
            ← Back to Signet
          </Link>
        )}
      </nav>
    </main>
  );
}
