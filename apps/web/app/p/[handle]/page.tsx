import { notFound } from 'next/navigation';
import { promises as fs } from 'fs';
import path from 'path';
import { SignetMonogram } from '../../(marketing)/components/signet-monogram';

type Profile = {
  name: string;
  wallet: string;
  bio: string;
  joined: string;
};

type Operation = {
  id: string;
  type: string;
  function?: string;
  decoded_function?: string;
  source_account?: string;
  created_at: string;
  transaction_hash?: string;
  transaction_successful?: boolean;
  asset_balance_changes?: Array<{
    asset_type: string;
    asset_code?: string;
    type: string;
    from?: string;
    to?: string;
    amount?: string;
  }>;
};

async function getProfile(handle: string): Promise<Profile | null> {
  try {
    const manifestPath = path.join(process.cwd(), 'public/data/profiles.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    return manifest[handle] ?? null;
  } catch {
    return null;
  }
}

async function getOperations(handle: string): Promise<Operation[]> {
  try {
    const opsPath = path.join(process.cwd(), 'public/data', `${handle}.json`);
    const raw = await fs.readFile(opsPath, 'utf-8');
    const data = JSON.parse(raw);
    return data._embedded?.records ?? [];
  } catch {
    return [];
  }
}

function truncate(str: string, head: number, tail: number): string {
  if (str.length <= head + tail + 3) return str;
  return `${str.slice(0, head)}...${str.slice(-tail)}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function resolveFunction(op: Operation): string {
  if (op.decoded_function && op.decoded_function !== '?') return op.decoded_function;
  if (op.function && !op.function.startsWith('HostFunction')) return op.function;
  return 'invoke_contract';
}

function stellarExpertTx(hash: string): string {
  return `https://stellar.expert/explorer/mainnet/tx/${hash}`;
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

  const operations = await getOperations(handle);
  const successfulOps = operations.filter((op) => op.transaction_successful !== false);

  const uniqueFunctions = new Set(successfulOps.map(resolveFunction));
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
            Profile · Stellar Mainnet
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
            <span className="inline-flex items-center gap-2 px-3 py-1.5 border border-emerald-800 bg-emerald-950/30">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span
                className="text-[10px] uppercase tracking-[0.22em] text-emerald-400"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                On-chain data · Horizon API
              </span>
            </span>
          </div>
        </div>
      </header>

      <div className="relative z-10 mx-auto max-w-5xl px-8 py-16 md:px-14">

        {/* Wallet */}
        <section className="mb-16">
          <SectionLabel>Linked wallet</SectionLabel>
          <div className="mt-6 border border-[#1f1d19]">
            <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
              <span
                className="text-[13px] text-[#b8b5a8]"
                style={{ fontFamily: 'var(--font-mono)' }}
                title={profile.wallet}
              >
                {truncate(profile.wallet, 8, 6)}
              </span>
              <a
                href={`https://stellar.expert/explorer/mainnet/account/${profile.wallet}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] uppercase tracking-[0.2em] text-[#8b1a1a] transition-colors hover:text-[#c2410c]"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                Stellar Expert ↗
              </a>
            </div>
          </div>
        </section>

        {/* Stats */}
        <section className="mb-16">
          <SectionLabel>On-chain activity</SectionLabel>
          <div className="mt-6 grid grid-cols-2 gap-px border border-[#1f1d19] bg-[#1f1d19] md:grid-cols-4">
            {[
              { label: 'Soroban invocations', value: String(successfulOps.length) },
              { label: 'Unique functions called', value: String(uniqueFunctions.size) },
              { label: 'First activity', value: oldest ? new Date(oldest.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—' },
              { label: 'Latest activity', value: newest ? fmtDate(newest.created_at) : '—' },
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

        {/* Operations */}
        <section className="mb-16">
          <SectionLabel>
            Soroban invocations
            <span className="ml-1 text-[#5e5b51]">· {operations.length} indexed</span>
          </SectionLabel>

          {operations.length === 0 ? (
            <div className="mt-6 border border-[#1f1d19] px-5 py-6">
              <p
                className="text-[13px] text-[#5e5b51]"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                No Soroban invocations indexed in this sample window.
              </p>
            </div>
          ) : (
            <div className="mt-6 border border-[#1f1d19]">
              {/* Header */}
              <div
                className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-[#1f1d19] px-5 py-3 text-[9px] uppercase tracking-[0.22em] text-[#5e5b51]"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                <span>Function</span>
                <span className="hidden md:block">Date</span>
                <span>Tx</span>
              </div>

              {operations.slice(0, 20).map((op, i) => {
                const fn = resolveFunction(op);
                const balChanges = op.asset_balance_changes ?? [];
                return (
                  <div
                    key={op.id}
                    className={`group grid grid-cols-[1fr_auto_auto] items-start gap-4 px-5 py-4 transition-colors hover:bg-[#0e0d0b] ${
                      i < Math.min(operations.length, 20) - 1 ? 'border-b border-[#1f1d19]' : ''
                    }`}
                  >
                    <div className="min-w-0">
                      <span
                        className="block font-medium text-[13px] text-[#b8b5a8]"
                        style={{ fontFamily: 'var(--font-mono)' }}
                      >
                        {fn}
                      </span>
                      {balChanges.length > 0 && (
                        <span
                          className="block text-[11px] text-[#5e5b51] mt-1"
                          style={{ fontFamily: 'var(--font-mono)' }}
                        >
                          {balChanges.map((bc, j) => (
                            <span key={j} className="mr-3">
                              {bc.type === 'transfer' ? '↔' : '·'}{' '}
                              {bc.amount} {bc.asset_code ?? 'XLM'}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                    <span
                      className="hidden text-[11px] text-[#5e5b51] md:block whitespace-nowrap"
                      style={{ fontFamily: 'var(--font-mono)' }}
                    >
                      {fmtDate(op.created_at)}
                    </span>
                    {op.transaction_hash ? (
                      <a
                        href={stellarExpertTx(op.transaction_hash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="whitespace-nowrap text-[10px] uppercase tracking-[0.18em] text-[#8b1a1a] transition-colors hover:text-[#c2410c]"
                        style={{ fontFamily: 'var(--font-mono)' }}
                      >
                        Verify ↗
                      </a>
                    ) : (
                      <span className="text-[10px] text-[#3d3a33]" style={{ fontFamily: 'var(--font-mono)' }}>—</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Verification footer */}
        <section className="pb-10">
          <SectionLabel>Verification</SectionLabel>
          <div className="mt-6 border border-[#1f1d19] px-6 py-6">
            <p
              className="max-w-[680px] text-[13px] leading-[1.7] text-[#5e5b51]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              Operations shown are real Soroban invocations fetched from the public Stellar
              Horizon API. Each row links to its transaction on Stellar Expert for independent
              verification. Handle-to-wallet bindings in this demo are curated by Signet;
              cryptographic self-attestation via an on-chain Identity Registry is planned for
              Phase 2.
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
            Stellar mainnet · live
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
