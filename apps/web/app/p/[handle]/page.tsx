import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { SectionLabel } from './_components/section-label';
import { SiteFooter } from './_components/site-footer';
import { SiteNav } from './_components/site-nav';
import {
  formatCount,
  formatStatsWindow,
  getProfile,
  isValidHandle,
} from '@/lib/profiles';
import { loadProfilePageData } from '@/lib/profile-page';
import { getProfileState } from '@/lib/profile-state';
import { STELLAR_EXPLORER, STELLAR_NETWORK_NAME } from '@/lib/network';
import { formatDate } from '@/lib/format-date';
import OperationsList from './operations-list';
import { CopyAddress } from './copy-address';
import { RestoreBinding } from '@/components/restore-binding';
import { REGISTRY_CONTRACT_ID } from '@/lib/chain';

// Rendered per request. The root layout reads request headers for the CSP
// nonce, so no route can be statically pre-rendered anyway, and handles are
// claimed on-chain continuously. Declaring it explicitly matters: a dynamic
// segment with no build-time params would otherwise be treated as ISR, where
// the layout's `headers()` call turns every profile render into a 500 instead
// of a page (or a clean 404 for an unknown handle).
export const dynamic = 'force-dynamic';

function truncate(str: string, head: number, tail: number): string {
  if (str.length <= head + tail + 3) return str;
  return `${str.slice(0, head)}...${str.slice(-tail)}`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  if (handle.toLowerCase() !== handle && isValidHandle(handle.toLowerCase())) {
    permanentRedirect(`/p/${handle.toLowerCase()}`);
  }

  const profile = await getProfile(handle);
  if (!profile) {
    return {
      title: 'Profile not found · Signet',
      description: 'Profile not found.',
      openGraph: {
        title: 'Profile not found · Signet',
        description: 'Profile not found.',
      },
      twitter: {
        title: 'Profile not found · Signet',
        description: 'Profile not found.',
      },
    };
  }

  const title =
    profile.name && profile.name.toLowerCase() !== handle.toLowerCase()
      ? `${profile.name} (@${handle}) · Signet`
      : `${handle} · Signet`;
  const description =
    profile.bio || `Verified Soroban activity and on-chain career record for ${handle}.`;

  return {
    title,
    description,
    alternates: {
      canonical: `/p/${handle}`,
    },
    openGraph: {
      title,
      description,
      url: `/p/${handle}`,
      type: 'profile',
    },
    twitter: {
      title,
      description,
    },
  };
}

export default async function ProfilePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;

  if (handle.toLowerCase() !== handle && isValidHandle(handle.toLowerCase())) {
    permanentRedirect(`/p/${handle.toLowerCase()}`);
  }

  const data = await loadProfilePageData(handle);
  if (!data) notFound();

  const {
    profile,
    operations,
    total,
    truncated,
    cap,
    source,
    stats,
    contracts,
    contractsTruncated,
    contractsCap,
    multiWallet,
  } = data;
  // Live, archived or no wallet: shared with the social card (#896).
  const state = getProfileState(profile);

  // The stats can outrun the capped operation list: database aggregates are
  // exact for their represented scope even when the list below stops at a cap.
  // When that scope is retention-bounded, the UI labels the window explicitly.
  const statsTruncated = truncated && !stats.exact;
  const statsWindow = formatStatsWindow(stats.retentionWindowDays);
  const historyWindowed = statsWindow !== null;
  const oldest = operations[operations.length - 1];
  const newest = operations[0];

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

      {/* Nav — shared with the contract sub-route (#445) */}
      <SiteNav />

      {/* Header */}
      <header className="relative z-10 border-b border-[#1f1d19] px-8 py-16 md:px-14 md:py-20">
        <div className="max-w-5xl">
          <div
            className="text-[11px] uppercase tracking-[0.26em] text-[var(--text-muted)]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {`Profile · Stellar ${STELLAR_NETWORK_NAME}`}
          </div>

          <h1
            className="mt-5 text-[56px] font-bold leading-[0.96] tracking-[-0.025em] text-[#f5f4ee] md:text-[88px]"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {profile.name}
          </h1>

          <div
            className="mt-3 text-[14px] uppercase tracking-[0.18em] text-[var(--text-muted)]"
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
            {state === 'archived' ? (
              <span className="inline-flex items-center gap-2 border border-amber-900/60 bg-amber-950/20 px-3 py-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                <span
                  className="text-[10px] uppercase tracking-[0.22em] text-amber-300"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  Archived on-chain · Identity Registry
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

        {/* An archived binding has no wallet to show, so its wallet, contracts
            and activity are hidden rather than rendered empty (#896). */}
        {state !== 'archived' && (
        <>
        {/* Wallet */}
        <section className="mb-16">
          <SectionLabel>Linked wallet</SectionLabel>
          <div className="mt-6 border border-[#1f1d19]">
            <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
              <CopyAddress
                address={profile.wallet}
                display={truncate(profile.wallet, 8, 6)}
              />
              {profile.wallet && (
                <a
                  href={`https://stellar.expert/explorer/${STELLAR_EXPLORER}/account/${profile.wallet}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-accent)] transition-colors hover:text-[var(--text-accent)]"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  Stellar Expert ↗
                </a>
              )}
            </div>
          </div>
        </section>

        {/* Deployed contracts — summary list only, no interface detail (#455) */}
        <section className="mb-16">
          <SectionLabel>
            Deployed contracts
            <span className="ml-1 text-[var(--text-muted)]">
              {contracts.length === 0
                ? '· none found'
                : contractsTruncated
                  ? `· ${contracts.length} shown · partial record`
                  : `· ${contracts.length} indexed`}
            </span>
          </SectionLabel>

          {contracts.length === 0 ? (
            <div className="mt-6 border border-[#1f1d19] bg-[#0e0d0b] px-5 py-6">
              <p
                className="text-[13px] leading-[1.7] text-[#b8b5a8]"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                No contracts are recorded for this profile&apos;s wallets yet.
              </p>
              <p
                className="mt-2 text-[12px] leading-[1.6] text-[var(--text-muted)]"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                The wallet that claimed this handle is rarely the key used with{' '}
                <code className="text-[#8a8779]">stellar contract deploy</code>. Link your deploy
                wallet from the CLI to attribute its contracts:
              </p>
              <code
                className="mt-4 block max-w-fit bg-[#0a0908] px-4 py-2.5 text-[12px] text-[#f5f4ee] border border-[#1f1d19]"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                npx @signet/cli link
              </code>
            </div>
          ) : (
            <div className="mt-6 border border-[#1f1d19]">
              <div
                className="grid grid-cols-[1fr_auto] gap-4 border-b border-[#1f1d19] px-5 py-3 text-[9px] uppercase tracking-[0.22em] text-[var(--text-muted)]"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                <span>Contract</span>
                <span>Deployed</span>
              </div>
              {contracts.map((c, i) => (
                <a
                  key={c.address}
                  href={`/p/${handle}/contract/${c.address}`}
                  className={`group grid grid-cols-[1fr_auto] items-start gap-4 px-5 py-4 transition-colors hover:bg-[#0e0d0b] ${
                    i < contracts.length - 1 ? 'border-b border-[#1f1d19]' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <span
                      className="block font-medium text-[13px] text-[#b8b5a8] transition-colors group-hover:text-[#f5f4ee]"
                      style={{ fontFamily: 'var(--font-mono)' }}
                    >
                      {truncate(c.address, 8, 6)}
                    </span>
                    {multiWallet && (
                      <span
                        className="block text-[11px] text-[var(--text-muted)] mt-1"
                        style={{ fontFamily: 'var(--font-mono)' }}
                      >
                        by {truncate(c.deployerPubkey, 8, 6)}
                      </span>
                    )}
                  </div>
                  <span
                    className="text-[11px] text-[var(--text-muted)] whitespace-nowrap"
                    style={{ fontFamily: 'var(--font-mono)' }}
                  >
                    {formatDate(c.deployedAt)}
                  </span>
                </a>
              ))}
            </div>
          )}

          {contractsTruncated && (
            <div className="mt-6 border border-amber-900/60 bg-amber-950/20 px-5 py-4">
              <p
                className="text-[12px] leading-[1.7] text-amber-300"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                Partial record — this profile may have deployed more contracts than shown.{' '}
                Without an indexer, deployments are read straight from Horizon, which we page
                through only as far as the {contractsCap} most recent operations.
              </p>
            </div>
          )}
        </section>

        {/* Stats */}
        <section className="mb-16">

          <SectionLabel>
            On-chain activity
            {statsWindow ? <span className="text-[var(--text-muted)]">· {statsWindow}</span> : null}
          </SectionLabel>
          <div className="mt-6 grid grid-cols-2 gap-px border border-[#1f1d19] bg-[#1f1d19] md:grid-cols-5">
            {[
              {
                label: statsTruncated ? 'Reputation (partial)' : 'Reputation',
                value: `${stats.reputation}`,
              },
              {
                label: 'Soroban invocations',
                value: formatCount(stats.invocations, statsTruncated),
              },
              {
                label: 'Unique functions called',
                value: formatCount(stats.uniqueFunctions, statsTruncated),
              },
              {
                // Without the full history the earliest record we hold is not
                // the developer's first activity, so the label stops claiming it.
                // The first page alone (`total > operations.length`) is not the
                // full history either, even when the record behind it is complete.
                label:
                  truncated || historyWindowed || total > operations.length
                    ? 'Earliest shown'
                    : 'First activity',
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
                  className="mt-2 text-[9px] uppercase tracking-[0.22em] text-[var(--text-muted)]"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  {label}
                </span>
              </div>
            ))}
          </div>
          {statsWindow && (
            <p
              className="mt-3 text-[11px] leading-[1.7] text-[var(--text-muted)]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              Statistics above cover the {statsWindow} retained by the indexer. Older operations
              age out of these totals as they are pruned.
            </p>
          )}
        </section>

        {/* Operations — paginated: first 25 rendered server-side */}
        <section className="mb-16">
          <SectionLabel>
            Soroban invocations
            <span className="ml-1 text-[var(--text-muted)]">
              {truncated ? `· ${total} shown · partial record` : `· ${total} indexed`}
            </span>
          </SectionLabel>

          {truncated && (
            <div className="mt-6 border border-amber-900/60 bg-amber-950/20 px-5 py-4">
              <p
                className="text-[12px] leading-[1.7] text-amber-300"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                Partial record — this account has more history than is shown. Without an indexer,
                activity is read straight from Horizon, which we page through only as far as the{' '}
                {cap} most recent operations.{' '}
                {statsTruncated
                  ? 'Counts above are lower bounds, and older invocations are not listed.'
                  : statsWindow
                    ? `The counts above are exact for the ${statsWindow} retention window, but older invocations are not listed.`
                    : 'The counts above are still exact — aggregated over the full indexed history — but older invocations are not listed.'}
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
            initialOperations={operations}
            total={total}
            truncated={truncated}
            cap={cap}
          />
        </section>
        </>
        )}

        {/* Verification footer */}
        <section className="pb-10">
          <SectionLabel>Verification</SectionLabel>
          <div className="mt-6 border border-[#1f1d19] px-6 py-6">
            {state === 'archived' ? (
              <p
                className="max-w-[680px] text-[13px] leading-[1.7] text-[var(--text-muted)]"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                This handle&apos;s binding is{' '}
                <strong className="text-amber-300">archived on-chain</strong>. The binding still
                exists in the Identity Registry on Stellar {STELLAR_NETWORK_NAME}, but its ledger
                entry has expired, so it no longer resolves to a wallet until it is restored.
              </p>
            ) : (
            <p
              className="max-w-[680px] text-[13px] leading-[1.7] text-[var(--text-muted)]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
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
                  {cap} most recent operations
                  {statsTruncated
                    ? ', so the counts above are lower bounds rather than totals.'
                    : statsWindow
                      ? `. The counts above are exact for the ${statsWindow} retention window.`
                      : '. The counts above are aggregated over the whole indexed history, so they stay exact totals.'}
                </>
              ) : null}
            </p>
            )}
            {state === 'archived' && (
              <div className="mt-6">
                <RestoreBinding handle={handle} registryContract={REGISTRY_CONTRACT_ID} />
              </div>
            )}
            <a
              href="/how-it-works"
              className="mt-4 inline-block text-[10px] uppercase tracking-[0.22em] text-[var(--text-accent)] transition-colors hover:text-[var(--text-accent)]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              How Signet works ↗
            </a>
          </div>
        </section>
      </div>

      {/* Footer — shared with the contract sub-route (#445) */}
      <SiteFooter />
    </div>
  );
}
