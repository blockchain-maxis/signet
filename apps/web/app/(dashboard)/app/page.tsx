import Link from 'next/link';
import { currentAddress } from '@/lib/server/session';
import { getAccount } from '@/lib/server/account';
import { getOperationsResult, computeStats, formatCount } from '@/lib/profiles';

function truncate(a: string): string {
  return a.length > 16 ? `${a.slice(0, 7)}…${a.slice(-5)}` : a;
}

const mono = { fontFamily: 'var(--font-mono)' } as const;
const display = { fontFamily: 'var(--font-display)' } as const;

export default async function DashboardPage() {
  const address = await currentAddress();
  const account = address ? await getAccount(address) : null;
  const operations = account?.handle ? await getOperationsResult(account.handle) : null;
  const stats = operations ? computeStats(operations.operations) : null;
  // Counts drawn from a capped window are lower bounds; they render as "N+".
  const truncated = operations?.truncated ?? false;

  return (
    <section>
      <h1 className="text-[40px] font-bold leading-[0.96] tracking-[-0.025em] md:text-[56px]" style={display}>
        Overview
      </h1>

      {/* Identity */}
      <div className="mt-8 max-w-[640px] border border-[#1f1d19]">
        <div className="flex items-center justify-between px-6 py-5">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-[#5e5b51]" style={mono}>
              Signed-in wallet
            </div>
            <div className="mt-1 text-[14px] text-[#b8b5a8]" style={mono} title={address ?? ''}>
              {address ? truncate(address) : '—'}
            </div>
          </div>
          {account?.handle ? (
            <Link
              href={`/p/${account.handle}`}
              className="text-[11px] uppercase tracking-[0.18em] text-[#8b1a1a] transition-colors hover:text-[#c2410c]"
              style={mono}
            >
              View profile ↗
            </Link>
          ) : null}
        </div>
        <div className="border-t border-[#1f1d19] px-6 py-5">
          {account?.handle ? (
            <p className="text-[13px] leading-[1.7] text-[#8a8779]" style={mono}>
              Handle <span className="text-[#b8b5a8]">@{account.handle}</span> is bound to this
              wallet on-chain via the Identity Registry.
            </p>
          ) : (
            <p className="text-[13px] leading-[1.7] text-[#8a8779]" style={mono}>
              No handle is bound to this wallet yet.{' '}
              <Link href="/#claim" className="text-[#8b1a1a] hover:text-[#c2410c]">
                Claim your handle
              </Link>{' '}
              to start your verifiable career record.
            </p>
          )}
        </div>
      </div>

      {/* On-chain stats (only once a handle is claimed) */}
      {stats && (
        <div className="mt-6 grid max-w-[640px] grid-cols-3 gap-px border border-[#1f1d19] bg-[#1f1d19]">
          {[
            { label: truncated ? 'Reputation (partial)' : 'Reputation', value: String(stats.reputation) },
            { label: 'Invocations', value: formatCount(stats.invocations, truncated) },
            { label: 'Functions', value: formatCount(stats.uniqueFunctions, truncated) },
          ].map(({ label, value }) => (
            <div key={label} className="flex flex-col justify-center bg-[#0a0908] px-6 py-6">
              <span className="text-[28px] font-bold leading-none text-[#f5f4ee]" style={display}>
                {value}
              </span>
              <span className="mt-2 text-[9px] uppercase tracking-[0.22em] text-[#5e5b51]" style={mono}>
                {label}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
