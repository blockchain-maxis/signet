import { SignetMonogram } from '../(marketing)/components/signet-monogram';

export const metadata = {
  title: 'How it works · Signet',
  description: 'A verifiable career record for Soroban developers, built on Stellar.',
};

export default function HowItWorksPage() {
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
          <a href="/p/aquawolf" className="transition-colors hover:text-[#f5f4ee]">Demo profiles</a>
        </div>
      </nav>

      <div className="relative z-10 mx-auto max-w-3xl px-8 py-16 md:px-14 md:py-20">

        <div
          className="text-[11px] uppercase tracking-[0.26em] text-[#5e5b51] mb-6"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          Signet · How it works
        </div>

        <h1
          className="text-[48px] font-bold leading-[0.96] tracking-[-0.025em] text-[#f5f4ee] mb-4 md:text-[72px]"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          How Signet works
        </h1>

        <p
          className="text-[17px] leading-[1.65] tracking-[-0.005em] text-[#8a8779] mb-16"
          style={{ fontFamily: 'var(--font-body)' }}
        >
          A verifiable career record for smart contract developers, built on Stellar.
        </p>

        <Section title="The problem">
          Smart contract developers have no portable record of their work. GitHub portfolios are
          unverifiable — anyone can fork code and claim authorship. Resumes are claims without
          proof. And when capital flows through a contract, the question &ldquo;who built this,
          and what&apos;s their track record?&rdquo; has no good answer.
        </Section>

        <Section title="The thesis">
          Every contract deployed to a public chain is cryptographically tied to the wallet that
          signed for it. That binding is unforgeable. Signet turns that binding into a career
          record: every contract a developer has shipped, the activity it&apos;s seen, the
          outcomes it&apos;s had — aggregated into one verifiable profile.
        </Section>

        <Section title="What's live today">
          The demo profiles at{' '}
          <code
            className="px-1.5 py-0.5 bg-[#1f1d19] border border-[#3d3a33] text-[#b8b5a8] text-[13px]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            /p/{'{handle}'}
          </code>{' '}
          render real on-chain data fetched from the public Stellar Horizon API. Each profile
          shows a wallet&apos;s Soroban activity — invocations, function calls, token balance
          changes — pulled directly from the public ledger. The handle-to-wallet mapping is
          currently hardcoded; cryptographic binding is planned for Phase 2.
        </Section>

        <Section title="What's coming">
          <span className="block mb-3">
            <strong className="text-[#f5f4ee]">On-chain identity registry (Soroban).</strong>{' '}
            A cryptographic binding of profile to wallet, written on-chain so anyone can verify
            independently. No Signet server in the trust chain.
          </span>
          <span className="block mb-3">
            <strong className="text-[#f5f4ee]">Indexer service.</strong>{' '}
            Continuous monitoring of registered wallets, capturing deployments and invocations in
            near real-time with full historical coverage.
          </span>
          <span className="block mb-3">
            <strong className="text-[#f5f4ee]">Reputation primitives.</strong>{' '}
            Peer attestations, outcome tracking (TVL handled, incidents, bug bounty payouts), and
            integrations with audit firms, grant programs, and hiring tools.
          </span>
          <span className="block">
            <strong className="text-[#f5f4ee]">Public SDK.</strong>{' '}
            Lets any external tool — a wallet, a grant application form, an insurance protocol —
            query a developer&apos;s Signet record and use it as input.
          </span>
        </Section>

        <Section title="Why Stellar">
          Stellar&apos;s institutional and RWA positioning means real, regulated capital flows
          through Soroban contracts — MoneyGram, Franklin Templeton, Circle. On chains where
          serious money is at stake, the question of who built a contract isn&apos;t academic.
          Signet makes that question answerable.
        </Section>

        <div className="mt-16 pt-10 border-t border-[#1f1d19]">
          <p
            className="text-[11px] uppercase tracking-[0.22em] text-[#5e5b51] mb-6"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            Live demos
          </p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {[
              { handle: 'aquawolf', name: 'Aqua Wolf', desc: 'Blend Protocol · collateral ops' },
              { handle: 'sorobuilder', name: 'Soro Builder', desc: 'Soroswap · DEX trades' },
              { handle: 'stellardev', name: 'Stellar Dev', desc: 'USDC · token transfers' },
            ].map(({ handle, name, desc }) => (
              <a
                key={handle}
                href={`/p/${handle}`}
                className="block border border-[#1f1d19] px-5 py-4 transition-colors hover:border-[#3d3a33] hover:bg-[#0e0d0b]"
              >
                <p
                  className="text-[13px] font-medium text-[#f5f4ee]"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  @{handle}
                </p>
                <p
                  className="text-[11px] text-[#5e5b51] mt-1"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  {desc}
                </p>
                <p
                  className="text-[10px] uppercase tracking-[0.2em] text-[#8b1a1a] mt-3"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  View profile →
                </p>
              </a>
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-t border-[#1f1d19] px-8 py-4 md:px-14">
        <div
          className="text-[10px] uppercase tracking-[0.22em] text-[#5e5b51]"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          Stellar Community Fund · 2026
        </div>
      </footer>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-12 pb-12 border-b border-[#1f1d19]">
      <h2
        className="text-[22px] font-semibold text-[#f5f4ee] mb-4 tracking-[-0.01em]"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {title}
      </h2>
      <p
        className="text-[15px] leading-[1.7] text-[#8a8779]"
        style={{ fontFamily: 'var(--font-body)' }}
      >
        {children}
      </p>
    </section>
  );
}
