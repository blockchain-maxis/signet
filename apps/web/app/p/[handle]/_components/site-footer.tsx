import { STELLAR_NETWORK_NAME } from '@/lib/network';

/**
 * Page footer shared by the profile page and the contract sub-route (#445).
 * Moved verbatim from `app/p/[handle]/page.tsx`.
 */
export function SiteFooter() {
  return (
    <footer className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-t border-[#1f1d19] px-8 py-4 md:px-14">
      <div
        className="flex items-center gap-7 text-[10px] uppercase tracking-[0.22em] text-[#8a8779]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        <span className="flex items-center gap-2.5">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#8b1a1a] opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#8b1a1a]" />
          </span>
          {`Stellar ${STELLAR_NETWORK_NAME.toLowerCase()}`}
        </span>
      </div>
      <div
        className="text-[10px] uppercase tracking-[0.22em] text-[#8a8779]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        Stellar Community Fund · 2026
      </div>
    </footer>
  );
}
