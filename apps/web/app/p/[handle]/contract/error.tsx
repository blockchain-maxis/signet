'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { isValidHandle } from '@signet/types';
import { STELLAR_NETWORK_NAME } from '@/lib/network';

// Lives in `contract/`, for the same reason as `not-found.tsx`: the layout is
// where attribution is decided, and it throws when neither the indexer nor
// Horizon can be reached. An error boundary beside that layout would not catch
// it. Page-level failures below the layout land here too, which is deliberate:
// this is the "couldn't reach the network" state. A spec that was reached but
// cannot be decoded is content, not an error, and renders on the page (#470).

const MONO = { fontFamily: 'var(--font-mono)' } as const;

export default function ContractError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  /** Re-fetches and re-renders the segment: what a server-side failure needs. */
  retry: () => void;
}) {
  const params = useParams<{ handle?: string }>();
  // Echo only a handle the registry could contain; the rest is whatever was typed in the URL.
  const handle =
    typeof params?.handle === 'string' && isValidHandle(params.handle) ? params.handle : null;

  useEffect(() => {
    // The message of a server error is redacted on the client; the digest is
    // what matches this to the server log.
    console.error('[signet] contract route error', error.digest);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#0a0908] px-6 text-center text-[#f5f4ee]">
      <div role="alert">
        <p className="mb-3 text-[11px] uppercase tracking-[0.26em] text-[#e05a4b]" style={MONO}>
          Network unreachable
        </p>
        <h1 className="text-4xl font-bold tracking-[-0.025em]" style={{ fontFamily: 'var(--font-display)' }}>
          Couldn&apos;t reach {STELLAR_NETWORK_NAME} right now
        </h1>
        <p className="mx-auto mt-4 max-w-sm text-sm text-[#8a8779]">
          Signet couldn&apos;t confirm this contract just now, so it shows nothing rather than something
          unverified. This is usually brief.
        </p>
      </div>
      {error.digest && (
        <p className="mt-3 text-[11px] text-[#8a8779]" style={MONO}>
          ref {error.digest}
        </p>
      )}
      <button
        type="button"
        onClick={() => retry()}
        className="mt-8 border border-[#e05a4b] px-6 py-3 text-[11px] uppercase tracking-[0.22em] transition-colors hover:bg-[#8b1a1a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908]"
        style={MONO}
      >
        Try again
      </button>
      {handle !== null && (
        <Link
          href={`/p/${handle}`}
          className="mt-8 text-[11px] uppercase tracking-[0.22em] text-[#e05a4b] transition-colors hover:text-[#f0806f]"
          style={MONO}
        >
          ← Back to @{handle}
        </Link>
      )}
    </main>
  );
}
