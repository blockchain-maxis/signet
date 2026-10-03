import { SignetMonogram } from '../../../(marketing)/components/signet-monogram';

/**
 * Top navigation shared by the profile page and the contract sub-route
 * (#445). Moved verbatim from `app/p/[handle]/page.tsx` so both surfaces
 * render one identical header.
 */
export function SiteNav() {
  return (
    <nav className="relative z-40 flex items-center justify-between border-b border-[#1f1d19] px-8 py-6 md:px-14">
      <a href="/" className="flex items-center gap-3">
        <SignetMonogram className="h-5 w-5 text-[#f5f4ee]" />
        <span className="text-[14px] font-medium tracking-tight">Signet</span>
      </a>
      <div
        className="hidden gap-8 text-[11px] uppercase tracking-[0.22em] text-[#8a8779] md:flex"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        <a href="/" className="transition-colors hover:text-[#f5f4ee]">Home</a>
        <a href="/how-it-works" className="transition-colors hover:text-[#f5f4ee]">How it works</a>
      </div>
      <a
        href="/#claim"
        className="text-[11px] uppercase tracking-[0.22em] text-[#f5f4ee]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        <span className="border-b border-[#8b1a1a] pb-1">Claim yours</span>
        <span className="ml-1.5 text-[#e05a4b]" aria-hidden="true">→</span>
      </a>
    </nav>
  );
}
