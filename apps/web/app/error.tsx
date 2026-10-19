'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaced to the browser console + any error-tracking provider wired up.
    console.error('[signet] route error', error.digest, error.message);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#0a0908] px-6 text-center text-[#f5f4ee]">
      <p
        className="mb-3 text-[11px] uppercase tracking-[0.26em] text-[var(--text-accent)]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        Something went wrong
      </p>
      <h1 className="text-4xl font-bold tracking-[-0.025em]" style={{ fontFamily: 'var(--font-display)' }}>
        Unexpected error
      </h1>
      {error.digest && (
        <p className="mt-3 text-[11px] text-[var(--text-muted)]" style={{ fontFamily: 'var(--font-mono)' }}>
          ref {error.digest}
        </p>
      )}
      <button
        type="button"
        onClick={reset}
        className="mt-8 border border-[#8b1a1a] px-6 py-3 text-[11px] uppercase tracking-[0.22em] transition-colors hover:bg-[#8b1a1a]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        Try again
      </button>
    </main>
  );
}
