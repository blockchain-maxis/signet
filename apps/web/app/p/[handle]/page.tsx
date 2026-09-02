import { notFound } from 'next/navigation';
import { SignetMonogram } from '../../(marketing)/components/signet-monogram';
import {
  getProfile,
  getOperationsResult,
  listAllHandles,
  computeStats,
  formatCount,
} from '@/lib/profiles';
import { STELLAR_EXPLORER, STELLAR_NETWORK_NAME } from '@/lib/network';
import { formatDate } from '@/lib/format-date';
import OperationsList from './operations-list';
import { CopyAddress } from './copy-address';

// Pre-render curated + on-chain-bound profiles at build time so they're served
// straight from the edge cache.
export async function generateStaticParams() {
  return (await listAllHandles()).map((handle) => ({ handle }));
}

// Handles are claimed on-chain continuously, so the set known at build time is
// always stale. Anything outside `generateStaticParams` is rendered on demand
// and then cached — a handle claimed after the last build resolves without a
// redeploy, and `getProfile` still returns null (→ 404) for one that was never
// claimed. Without this, a miss would be a hard 404 until the next deploy.
export const dynamicParams = true;

// Re-render a cached profile at most once a minute, so newly indexed on-chain
// activity shows up shortly after it lands instead of being frozen at the
// value captured on first render. Short enough to feel live, long enough that
// a shared profile link doesn't re-query Postgres on every view.
export const revalidate = 60;

function truncate(str: string, head: number, tail: number): string {
  if (str.length <= head + tail + 3) return str;
  return `${str.slice(0, head)}...${str.slice(-tail)}`;
}

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return {
    title: `${handle} · Signet`,
    description: `Verified Soroban activity and on-chain career record for ${handle}.`,
  };
}

export default async function ProfilePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;

  const profile = await getProfile(handle);
  if (!profile) notFound();

  // `truncated` says the record stops at a cap rather than at the end of this
  // developer's history. Every claim below that would otherwise read as a total
  // is qualified by it — a partial record shown as complete is the one thing a
  // career record must never do.
  const { operations, truncated, cap, source } = await getOperationsResult(handle);
  const stats = computeStats(operations);
  const oldest = operations[operations.length - 1];
  const newest = operations[0];
  // A curated demo profile and a handle actually bound on-chain render through
  // the same route, so provenance drives every claim the page makes about the
  // data — neither may borrow the other's framing.
  const isDemo = profile.source === 'demo';

  return (
    <div
      className="relative min-h-screen bg-[#0a0908] text-[#f5f4ee]"
    >
      {/* Grain */}
      <div
        className="pointer-events-none fixed inset-0 z-30 opacity-[0.07] mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240' viewBox='0 0 240 240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        }}
        aria-hidden="true"
      />

      {/* Nav */}
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
          <span className="ml-1.5 text-[#8b1a1a]">→</span>
        </a>
      </nav>

      {/* Header */}
      <header className="relative z-10 border-b border-[#1f1d19] px-8 py-16 md:px-14 md:py-20">
        <div className="max-w-5xl">
          <div
            className="text-[11px] uppercase tracking-[0.26em] text-[#5e5b51]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {isDemo ? 'Profile · Stellar Testnet · Demo' : `Profile · Stellar ${STELLAR_NETWORK_NAME}`}
          </div>

          <h1
            className="mt-5 text-[56px] font-bold leading-[0.96] tracking-[-0.025em] text-[#f5f4ee] md:text-[88px]"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {profile.name}
          </h1>

          <div
            className="mt-3 text-[14px] uppercase tracking-[0.18em] text-[#5e5b51]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            @{handle}
          </div>

          {profile.bio && (
            <p className="mt-5 max-w-[560px] text-[16px] leading-[1.6] text-[#8a8779]">
              {profile.bio}
            </p>
          )}

          <div className="mt-7 flex items-center gap-3">
            {isDemo ? (
              <span className="inline-flex items-center gap-2 border border-amber-800 bg-amber-950/30 px-3 py-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                <span
                  className="text-[10px] uppercase tracking-[0.22em] text-amber-400"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  Synthetic data · Testnet demo
                </span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-2 border border-emerald-800 bg-emerald-950/30 px-3 py-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <span
                  className="text-[10px] uppercase tracking-[0.22em] text-emerald-400"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  Bound on-chain · Identity Registry
                </span>
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="relative z-10 mx-auto max-w-5xl px-8 py-16 md:px-14">

        {/* Wallet */}
        <section className="mb-16">
          <SectionLabel>Linked wallet</SectionLabel>
          <div className="mt-6 border border-[#1f1d19]">
            <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
              <CopyAddress
                address={profile.wallet}
                display={truncate(profile.wallet, 8, 6)}
              />
              {/* Demo wallets are synthetic and don't exist on-chain, so an
                  explorer link would land on an empty account page. */}
              {isDemo ? null : (
                <a
                  href={`https://stellar.expert/explorer/${STELLAR_EXPLORER}/account/${profile.wallet}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] uppercase tracking-[0.2em] text-[#8b1a1a] transition-colors hover:text-[#c2410c]"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  Stellar Expert ↗
                </a>
              )}
            </div>
          </div>
        </section>

        {/* Stats */}
        <section className="mb-16">
          <SectionLabel>On-chain activity</SectionLabel>
          <div className="mt-6 grid grid-cols-2 gap-px border border-[#1f1d19] bg-[#1f1d19] md:grid-cols-5">
            {[
              { label: truncated ? 'Reputation (partial)' : 'Reputation', value: `${stats.reputation}` },
              {
                label: 'Soroban invocations',
                value: formatCount(stats.invocations, truncated),
              },
              {
                label: 'Unique functions called',
                value: formatCount(stats.uniqueFunctions, truncated),
              },
              {
                // Without the full history the earliest record we hold is not
                // the developer's first activity, so the label stops claiming it.
                label: truncated ? 'Earliest shown' : 'First activity',
                value: oldest ? formatDate(oldest.created_at, { day: undefined }) : '—',
              },
              { label: 'Latest activity', value: newest ? formatDate(newest.created_at) : '—' },
            ].map(({ label, value }) => (
              <div key={label} className="flex flex-col justify-center bg-[#0a0908] px-6 py-6">
                <span
                  className="text-[32px] font-bold leading-none tracking-[-0.025em] text-[#f5f4ee]"
                  style={{ fontFamily: 'var(--font-display)' }}
                >
                  {value}
                </span>
                <span
                  className="mt-2 text-[9px] uppercase tracking-[0.22em] text-[#5e5b51]"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  {label}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* Operations — paginated: first 25 rendered server-side */}
        <section className="mb-16">
          <SectionLabel>
            Soroban invocations
            <span className="ml-1 text-[#5e5b51]">
              {truncated
                ? `· ${operations.length} shown · partial record`
                : `· ${operations.length} indexed`}
            </span>
          </SectionLabel>

          {truncated && (
            <div className="mt-6 border border-amber-900/60 bg-amber-950/20 px-5 py-4">
              <p
                className="text-[12px] leading-[1.7] text-amber-300"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                Partial record — this account has more history than is shown.{' '}
                {source === 'horizon'
                  ? `Without an indexer, activity is read straight from Horizon, which we page through only as far as the ${cap} most recent operations.`
                  : `The indexer read only the ${cap} most recent operations for this wallet.`}{' '}
                Counts above are lower bounds, and older invocations are not listed.
              </p>
              <a
                href={`https://stellar.expert/explorer/${STELLAR_EXPLORER}/account/${profile.wallet}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-block text-[10px] uppercase tracking-[0.2em] text-amber-400 transition-colors hover:text-amber-200"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                Full history on Stellar Expert ↗
              </a>
            </div>
          )}

          <OperationsList
            handle={handle}
            initialOperations={operations.slice(0, 25)}
            total={operations.length}
            isDemo={isDemo}
            truncated={truncated}
            cap={cap}
          />
        </section>

        {/* Verification footer */}
        <section className="pb-10">
          <SectionLabel>Verification</SectionLabel>
          <div className="mt-6 border border-[#1f1d19] px-6 py-6">
            <p
              className="max-w-[680px] text-[13px] leading-[1.7] text-[#5e5b51]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {isDemo ? (
                <>
                  This is a <strong className="text-[#8a8779]">demo profile</strong> populated with
                  synthetic data on Stellar testnet — no real account&apos;s activity is shown. In
                  production, profiles render real mainnet Soroban invocations from the Horizon
                  API, each independently verifiable on Stellar Expert, with the handle→wallet
                  binding proved on-chain via the Identity Registry rather than curated.
                </>
              ) : (
                <>
                  This handle is{' '}
                  <strong className="text-[#8a8779]">bound on-chain</strong> — the handle→wallet
                  binding above was read live from the Identity Registry contract on Stellar{' '}
                  {STELLAR_NETWORK_NAME}, not curated. Any Soroban invocations listed come from the
                  indexed ledger and are independently verifiable on Stellar Expert.
                  {truncated ? (
                    <>
                      {' '}
                      This particular record is{' '}
                      <strong className="text-[#8a8779]">partial</strong>: it stops at the{' '}
                      {cap} most recent operations, so the counts above are lower bounds rather
                      than totals.
                    </>
                  ) : null}
                </>
              )}
            </p>
            <a
              href="/how-it-works"
              className="mt-4 inline-block text-[10px] uppercase tracking-[0.22em] text-[#8b1a1a] transition-colors hover:text-[#c2410c]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              How Signet works ↗
            </a>
          </div>
        </section>
      </div>

      {/* Footer */}
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
            {isDemo ? 'Stellar testnet · demo' : `Stellar ${STELLAR_NETWORK_NAME.toLowerCase()}`}
          </span>
        </div>
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-center gap-3 text-[10px] uppercase tracking-[0.26em] text-[#8a8779]"
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-[#8b1a1a]" aria-hidden="true" />
      {children}
    </div>
  );
}
