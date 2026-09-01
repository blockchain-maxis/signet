import { SignetMonogram } from '../(marketing)/components/signet-monogram';
import { listDirectory } from '@/lib/directory';

export const metadata = {
  title: 'Handles · Signet',
  description: 'Every handle recorded on the Signet Identity Registry.',
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

  const { entries, boundTotal, source } = await listDirectory();

  // Only handles the contract confirmed just now may be presented as bound.
  // Everything else is a demo persona and is rendered as such, in its own
  // section, under its own label — never counted, never mixed in.
  const bound = entries.filter((e) => e.bound);
  const previews = entries.filter((e) => !e.bound);

  // Pagination applies to the bound list, the only one that can grow.
  const totalPages = Math.max(1, Math.ceil(bound.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageEntries = bound.slice(start, start + PAGE_SIZE);

  // `boundTotal` is null when the registry could not be read at all. Saying
  // "0 handles" there would assert an on-chain fact we never observed. And when
  // it IS readable, it is the registry's own counter — an upper bound, not the
  // number "currently bound": a binding that lapses from storage unaccessed is
  // never subtracted, so the counter can only drift upward. "Recorded" is the
  // claim the page can actually stand behind.
  const caption =
    boundTotal === null
      ? 'The Identity Registry is not readable from this deployment yet, so no on-chain bindings can be shown.'
      : `${boundTotal} handle${boundTotal === 1 ? '' : 's'} recorded by the Identity Registry.`;

  // The count comes from the contract's counter; what the list can contain
  // depends on which source discovered it. Read from the indexer's database,
  // nothing ages out — a shortfall means the counter drifted upward over a
  // lapsed binding, or the indexer has not caught up yet. Read from the event
  // stream alone, a public RPC only serves roughly the last 11 hours, so
  // everything claimed before that is invisible and the shortfall grows
  // without limit as the registry ages. The copy must not collapse those into
  // one sentence, and must not report "nobody has claimed a handle" over a
  // registry whose counter says otherwise.
  const unlisted = boundTotal === null ? 0 : Math.max(0, boundTotal - bound.length);
  const windowed = source === 'events';
  const shortfallReason = windowed
    ? "claimed before the registry's event window, or lapsed from storage without the counter noticing"
    : 'not yet synced by the indexer, or lapsed from storage without the counter noticing';
  const emptyState =
    boundTotal === null
      ? { message: 'No registry is configured for this deployment.', invite: false }
      : boundTotal === 0
        ? { message: 'Nobody has bound a handle yet.', invite: true }
        : {
            message: windowed
              ? `The registry's counter records ${boundTotal} handle${boundTotal === 1 ? '' : 's'}, but ${boundTotal === 1 ? 'it was not' : 'none were'} claimed recently enough to appear in the event window. Resolve a handle directly to confirm a live binding.`
              : `The registry's counter records ${boundTotal} handle${boundTotal === 1 ? '' : 's'}, but none of them resolve right now. Resolve a handle directly to confirm a live binding.`,
            invite: false,
          };

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
          <p className="mt-5 max-w-[560px] text-[16px] leading-[1.6] text-[#8a8779]">{caption}</p>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-8 py-16 md:px-14">
        {bound.length === 0 ? (
          <div className="border border-[#1f1d19] px-6 py-10 text-center">
            <p className="mx-auto max-w-[460px] text-[14px] leading-[1.7] text-[#8a8779]">
              {emptyState.message}
            </p>
            {emptyState.invite && (
              <a
                href="/#claim"
                className="mt-4 inline-block text-[10px] uppercase tracking-[0.22em] text-[#8b1a1a] transition-colors hover:text-[#c2410c]"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                Be the first ↗
              </a>
            )}
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

            {unlisted > 0 && (
              <p className="mt-4 text-[12px] leading-[1.7] text-[#5e5b51]">
                The registry&apos;s counter records {unlisted} further binding
                {unlisted === 1 ? '' : 's'} not verifiable here — {shortfallReason}. Resolve a
                handle directly to confirm {unlisted === 1 ? 'it' : 'one'}.
              </p>
            )}

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

        {previews.length > 0 && (
          <section className="mt-14">
            <div className="flex flex-wrap items-center gap-3">
              <h2
                className="text-[10px] uppercase tracking-[0.26em] text-[#8a8779]"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                Demo profiles
              </h2>
              <span className="inline-flex items-center gap-2 border border-amber-800 bg-amber-950/30 px-3 py-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                <span
                  className="text-[10px] uppercase tracking-[0.22em] text-amber-400"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  Not bound on-chain
                </span>
              </span>
            </div>

            <p className="mt-4 max-w-[560px] text-[13px] leading-[1.7] text-[#5e5b51]">
              Curated personas with synthetic testnet activity, kept here so the directory has
              something to show before the first real claim. They are not registry bindings and are
              not counted above.
            </p>

            <div className="mt-6 grid grid-cols-1 gap-px border border-[#1f1d19] bg-[#1f1d19] sm:grid-cols-2">
              {previews.map(({ handle }) => (
                <a
                  key={handle}
                  href={`/p/${handle}`}
                  className="flex items-center justify-between gap-4 bg-[#0a0908] px-5 py-4 transition-colors hover:bg-[#0e0d0b]"
                >
                  <span
                    className="text-[14px] font-medium text-[#8a8779]"
                    style={{ fontFamily: 'var(--font-mono)' }}
                  >
                    @{handle}
                  </span>
                  <span
                    className="text-[10px] uppercase tracking-[0.2em] text-[#5e5b51]"
                    style={{ fontFamily: 'var(--font-mono)' }}
                  >
                    Demo
                  </span>
                </a>
              ))}
            </div>
          </section>
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
