import { SignetMonogram } from '../(marketing)/components/signet-monogram';
import { listDirectory } from '@/lib/directory';

export const metadata = {
  title: 'Handles · Signet',
  description: 'Every handle currently bound on the Signet Identity Registry.',
};

const PAGE_SIZE = 24;

function truncateWallet(wallet: string): string {
  if (wallet.length <= 14) return wallet;
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

export default async function HandlesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageParam } = await searchParams;
  const requestedPage = Number(pageParam ?? '1');
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const entries = await listDirectory();
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageEntries = entries.slice(start, start + PAGE_SIZE);

  return (
    <div className="relative min-h-screen bg-[#0a0908] text-[#f5f4ee]">
      <nav className="flex items-center justify-between border-b border-[#1f1d19] px-8 py-6 md:px-14">
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
          <span className="ml-1.5 text-[#8b1a1a]">→</span>
        </a>
      </nav>

      <header className="border-b border-[#1f1d19] px-8 py-16 md:px-14 md:py-20">
        <div className="max-w-5xl">
          <div
            className="text-[11px] uppercase tracking-[0.26em] text-[#5e5b51]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            Directory
          </div>
          <h1
            className="mt-5 text-[48px] font-bold leading-[0.96] tracking-[-0.025em] text-[#f5f4ee] md:text-[72px]"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Handles
          </h1>
          <p className="mt-5 max-w-[560px] text-[16px] leading-[1.6] text-[#8a8779]">
            {entries.length === 0
              ? 'Every handle currently bound on the Identity Registry.'
              : `${entries.length} handle${entries.length === 1 ? '' : 's'} currently bound on the Identity Registry.`}
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-8 py-16 md:px-14">
        {entries.length === 0 ? (
          <div className="border border-[#1f1d19] px-6 py-10 text-center">
            <p className="text-[14px] text-[#8a8779]">Nobody has bound a handle yet.</p>
            <a
              href="/#claim"
              className="mt-4 inline-block text-[10px] uppercase tracking-[0.22em] text-[#8b1a1a] transition-colors hover:text-[#c2410c]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              Be the first ↗
            </a>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-px border border-[#1f1d19] bg-[#1f1d19] sm:grid-cols-2">
              {pageEntries.map(({ handle, wallet }) => (
                <a
                  key={handle}
                  href={`/p/${handle}`}
                  className="flex items-center justify-between gap-4 bg-[#0a0908] px-5 py-4 transition-colors hover:bg-[#0e0d0b]"
                >
                  <span
                    className="text-[14px] font-medium text-[#f5f4ee]"
                    style={{ fontFamily: 'var(--font-mono)' }}
                  >
                    @{handle}
                  </span>
                  {wallet && (
                    <span
                      className="text-[11px] text-[#5e5b51]"
                      style={{ fontFamily: 'var(--font-mono)' }}
                      title={wallet}
                    >
                      {truncateWallet(wallet)}
                    </span>
                  )}
                </a>
              ))}
            </div>

            {totalPages > 1 && (
              <div
                className="mt-8 flex items-center justify-between text-[11px] uppercase tracking-[0.22em] text-[#8a8779]"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                {currentPage > 1 ? (
                  <a href={`/handles?page=${currentPage - 1}`} className="hover:text-[#f5f4ee]">
                    ← Previous
                  </a>
                ) : (
                  <span className="text-[#3d3a33]">← Previous</span>
                )}
                <span>
                  Page {currentPage} of {totalPages}
                </span>
                {currentPage < totalPages ? (
                  <a href={`/handles?page=${currentPage + 1}`} className="hover:text-[#f5f4ee]">
                    Next →
                  </a>
                ) : (
                  <span className="text-[#3d3a33]">Next →</span>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[#1f1d19] px-8 py-4 md:px-14">
        <div
          className="text-[10px] uppercase tracking-[0.22em] text-[#3d3a33]"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          Stellar Community Fund · 2026
        </div>
      </footer>
    </div>
  );
}
