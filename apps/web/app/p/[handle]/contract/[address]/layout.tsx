import { notFound } from 'next/navigation';
import { attributeContract } from '@/lib/contract-attribution';
import { SiteFooter } from '../../_components/site-footer';
import { SiteNav } from '../../_components/site-nav';
import { AnnounceProvider } from './announcer';
import { ContractHeader } from './_components/contract-header';
import { ContractTabsNav } from './tabs-nav';
import { TabFocus } from './tab-focus';

// Rendered per request. The root layout reads request headers for the CSP
// nonce, so no route can be statically pre-rendered anyway, and attribution
// is a live DB/Horizon question. Declaring it explicitly matters: a dynamic
// segment with no build-time params would otherwise be treated as ISR, where
// the layout's `headers()` call turns every render into a 500 instead of a
// page (or a clean 404 for a contract this handle did not deploy). The
// setting covers every child segment below this layout.
export const dynamic = 'force-dynamic';

function truncate(str: string, head: number, tail: number): string {
  if (str.length <= head + tail + 3) return str;
  return `${str.slice(0, head)}...${str.slice(-tail)}`;
}

/**
 * Shell for the per-contract documentation route (#445, design §2.1):
 * attribution gate, profile identity strip, header slot, tab bar. Every
 * later issue fills a slot; this layout owns the frame.
 */
export default async function ContractLayout({
  params,
  children,
}: {
  params: Promise<{ handle: string; address: string }>;
  children: React.ReactNode;
}) {
  const { handle, address } = await params;

  // One attribution check for the whole route: the contract renders as part
  // of this developer's record, so a contract the handle did not deploy is a
  // 404 — a real one, not a 200 with a not-found body. `invalid` (malformed
  // handle or address) is indistinguishable from the outside on purpose.
  const attribution = await attributeContract(handle, address);
  if (attribution.status === 'not-attributed' || attribution.status === 'invalid') {
    notFound();
  }

  return (
    <AnnounceProvider>
    <div className="relative min-h-screen bg-[#0a0908] text-[#f5f4ee]">
      {/* Skip link (#461): first tab stop, visible only while focused. */}
      <a
        href="#contract-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-[#0a0908] focus:px-3 focus:py-2 focus:text-[11px] focus:uppercase focus:tracking-[0.22em] focus:text-[#f5f4ee] focus:outline focus:outline-2 focus:outline-[#e05a4b]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        Skip to contract content
      </a>
      {/* Grain */}
      <div
        className="pointer-events-none fixed inset-0 z-30 opacity-[0.07] mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240' viewBox='0 0 240 240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        }}
        aria-hidden="true"
      />

      <SiteNav />

      {attribution.status === 'unavailable' ? (
        // Attribution could not be decided (DB and Horizon both unreachable).
        // Neither a 404 (the claim might be true) nor the page (it might not
        // be) is honest here; #459 builds the full error state, this is the
        // minimal truthful placeholder until then.
        <main id="contract-content" className="relative z-10 mx-auto max-w-5xl px-8 py-16 md:px-14">
          <p
            className="text-[13px] leading-[1.7] text-[#8a8779]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            Attribution for this contract can&apos;t be verified right now — the indexer and
            Horizon are both unreachable. Nothing is shown rather than something unverified.
            Try again shortly.
          </p>
        </main>
      ) : (
        <>
          {/* Identity strip: the contract is shown as part of this
              developer's record, and the route says so. */}
          <div className="relative z-10 border-b border-[#1f1d19] px-8 py-4 md:px-14">
            {/* The page's single h1 (#461): short address, by the handle. */}
            <h1
              className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-normal uppercase tracking-[0.22em]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              <span className="text-[#8a8779]" title={address}>
                {truncate(address, 8, 6)}
              </span>{' '}
              <span className="text-[#8a8779]">by</span>{' '}
              <a
                href={`/p/${handle}`}
                className="text-[#e05a4b] transition-colors hover:text-[#f0806f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908]"
              >
                @{handle}
              </a>
            </h1>
          </div>

          {/* Header slot (#448): on every tab, from the same attribution. */}
          <div className="relative z-10 px-8 pt-10 md:px-14" data-slot="contract-header">
            <ContractHeader handle={handle} contract={attribution.contract} />
          </div>

          <ContractTabsNav handle={handle} address={address} />

          <main id="contract-content" className="relative z-10 mx-auto max-w-5xl px-8 py-16 md:px-14">
            <TabFocus>{children}</TabFocus>
          </main>
        </>
      )}

      <SiteFooter />
    </div>
    </AnnounceProvider>
  );
}
