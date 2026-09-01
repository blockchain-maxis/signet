import type { WalletSource } from '@signet/types';
import { currentAddress } from '@/lib/server/session';
import { getAccountWallets } from '@/lib/server/account';
import { isRegistryConfigured, lookupWallet } from '@/lib/server/registry-read';
import { stellarExpertAccountUrl } from '@/lib/network';

function truncate(a: string): string {
  return a.length > 18 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

/** Badge styling for each wallet provenance, keyed by the shared WalletSource type. */
const SOURCE_BADGE: Record<WalletSource, { label: string; className: string }> = {
  onchain: { label: '● on-chain', className: 'text-emerald-500' },
  curated: { label: '○ curated', className: 'text-[#5e5b51]' },
  cli: { label: '○ cli', className: 'text-[#5e5b51]' },
};

const mono = { fontFamily: 'var(--font-mono)' } as const;
const display = { fontFamily: 'var(--font-display)' } as const;

export default async function WalletsPage() {
  const address = await currentAddress();
  const registryConfigured = isRegistryConfigured();

  let wallets = address ? await getAccountWallets(address) : [];

  // When the indexer/database has nothing yet, read the binding straight from
  // the on-chain registry so a wallet claimed on-chain still shows up.
  if (address && wallets.length === 0 && registryConfigured) {
    const handle = await lookupWallet(address);
    if (handle) {
      wallets = [{ pubkey: address, isPrimary: true, source: 'onchain', attestedAt: '' }];
    }
  }

  return (
    <section>
      <h1 className="text-[40px] font-bold leading-[0.96] tracking-[-0.025em] md:text-[56px]" style={display}>
        Wallets
      </h1>

      <p className="mt-6 max-w-[640px] text-[14px] leading-[1.7] text-[#8a8779]" style={mono}>
        Wallets linked to your handle. Each binding is a signed proof of ownership written to the
        on-chain Identity Registry, so the contracts a wallet has deployed are attributed to you.
      </p>

      <div className="mt-8 max-w-[640px] border border-[#1f1d19]">
        {wallets.length === 0 ? (
          <p className="px-6 py-6 text-[13px] leading-[1.7] text-[#5e5b51]" style={mono}>
            {registryConfigured
              ? 'No wallets are linked yet. Claim a handle on-chain and the signing wallet is attributed here automatically.'
              : 'The Identity Registry is not deployed on this network yet, so on-chain wallet bindings can’t be read.'}
          </p>
        ) : (
          wallets.map((w, i) => (
            <div
              key={w.pubkey}
              className={`flex flex-wrap items-center justify-between gap-4 px-6 py-4 ${
                i < wallets.length - 1 ? 'border-b border-[#1f1d19]' : ''
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="text-[13px] text-[#b8b5a8]" style={mono} title={w.pubkey}>
                  {truncate(w.pubkey)}
                </span>
                {w.isPrimary && (
                  <span className="border border-[#1f1d19] px-2 py-0.5 text-[9px] uppercase tracking-[0.18em] text-[#8a8779]" style={mono}>
                    Primary
                  </span>
                )}
                <span
                  className={`text-[9px] uppercase tracking-[0.18em] ${SOURCE_BADGE[w.source].className}`}
                  style={mono}
                >
                  {SOURCE_BADGE[w.source].label}
                </span>
              </div>
              <a
                href={stellarExpertAccountUrl(w.pubkey)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] uppercase tracking-[0.2em] text-[#8b1a1a] transition-colors hover:text-[#c2410c]"
                style={mono}
              >
                Explorer ↗
              </a>
            </div>
          ))
        )}
      </div>

      <p className="mt-4 max-w-[640px] text-[12px] leading-[1.7] text-[#5e5b51]" style={mono}>
        To link an additional wallet, claim a handle from it in the Identity Registry — bindings are
        created on-chain, never from this dashboard.
      </p>
    </section>
  );
}
