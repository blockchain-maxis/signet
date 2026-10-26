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
          <a href="/handles" className="transition-colors hover:text-[#f5f4ee]">Handles</a>
        </div>
      </nav>

      <div className="relative z-10 mx-auto max-w-3xl px-8 py-16 md:px-14 md:py-20">

        <div
          className="text-[11px] uppercase tracking-[0.26em] text-[var(--text-muted)] mb-6"
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
          The <strong className="text-[#f5f4ee]">Identity Registry</strong> is deployed and
          initialized on Stellar testnet, and handle-to-wallet bindings are claimed on-chain: a
          wallet owner authorizes a <code
            className="px-1.5 py-0.5 bg-[#1f1d19] border border-[#3d3a33] text-[#b8b5a8] text-[13px]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >claim(handle, wallet)</code> call, and Soroban requires a valid signature from that
          wallet&apos;s key, so no off-chain admin can mint an identity. Profiles at{' '}
          <code
            className="px-1.5 py-0.5 bg-[#1f1d19] border border-[#3d3a33] text-[#b8b5a8] text-[13px]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            /p/{'{handle}'}
          </code>{' '}
          and the <code
            className="px-1.5 py-0.5 bg-[#1f1d19] border border-[#3d3a33] text-[#b8b5a8] text-[13px]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >/handles</code> directory read those bindings live from the registry. Nothing is
          curated or seeded: a handle appears only once it is actually bound on-chain.
        </Section>

        <Section title="How a contract gets attributed to you">
          <span className="block mb-3">
            Every contract a wallet deploys is recorded on-chain with the account that signed the
            deploy. When one of your linked wallets deployed a contract, Signet gives it a page under
            your handle, <Code>/p/{'{handle}'}/contract/{'{address}'}</Code>, with its interface,
            generated docs, a diagram and its activity. Asking for a contract under a handle that did
            not deploy it is a 404, so nobody can put your work under their name, or theirs under
            yours.
          </span>
          <span className="block mb-3">
            Signet checks its indexer&apos;s record of deployments first. A deployment without an
            indexer walks the wallet&apos;s history on Horizon instead.
          </span>
          <span className="block mb-2 text-[#b8b5a8]">What it does not do:</span>
          <span className="block mb-1">
            It attributes direct deployments only, not contracts created by a factory contract on
            your behalf.
          </span>
          <span className="block mb-1">
            Without an indexer, only the most recent 400 operations of a wallet are searched, so an
            older deployment is not found.
          </span>
          <span className="block">
            Upgrade history starts when indexing began: an upgrade made before Signet saw the contract
            does not appear.
          </span>
        </Section>

        <Section title="Run it locally">
          <span className="block mb-3">
            <Code>signet dev</Code> runs a deployed contract on your own machine: it forks the
            contract&apos;s ledger state from a Soroban RPC, builds your changed source, and replays
            saved and real transactions against both versions, then shows what changed: return
            values, events, storage, authorisation and cost.
          </span>
          <span className="block">
            Nothing executes on Signet&apos;s servers. The CLI and the simulator run where you run
            them, and your source never leaves your machine. The guide is{' '}
            <Code>docs/SANDBOX.md</Code>.
          </span>
        </Section>

        <Section title="What's coming">
          <span className="block mb-3">
            <strong className="text-[#f5f4ee]">Published CLI.</strong>{' '}
            The <Code>signet</Code> CLI is built and documented in <Code>docs/CLI.md</Code>:
            linking the deploy wallet you ship contracts from to your claimed handle, and{' '}
            <Code>signet dev</Code>. It is not on npm yet, so for now it is built from source.
            Linking is the step that turns a claimed handle into an indexed profile: a handle
            claimed with a browser wallet points at an address that has usually deployed nothing.
          </span>
          <span className="block mb-3">
            <strong className="text-[#f5f4ee]">Indexer service.</strong>{' '}
            The indexer is built but not yet running against this deployment&apos;s database.
            Running it keeps profiles current with deployments and invocations as they happen.
          </span>
          <span className="block mb-3">
            <strong className="text-[#f5f4ee]">Reputation primitives.</strong>{' '}
            Peer attestations, outcome tracking (TVL handled, incidents, bug bounty payouts), and
            integrations with audit firms, grant programs, and hiring tools.
          </span>
          <span className="block">
            <strong className="text-[#f5f4ee]">The SDK on npm.</strong>{' '}
            The public API (<Code>/api/v1</Code>, documented at <Code>/docs/api</Code>) and{' '}
            <Code>@signet/sdk</Code> exist today, so a wallet, a grant application form or an
            insurance protocol can query a developer&apos;s record. Publishing the SDK to npm is next.
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
            className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-muted)] mb-6"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            Directory
          </p>
          <a
            href="/handles"
            className="block border border-[#1f1d19] px-5 py-4 transition-colors hover:border-[#3d3a33] hover:bg-[#0e0d0b]"
          >
            <p
              className="text-[13px] font-medium text-[#f5f4ee]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              /handles
            </p>
            <p
              className="text-[11px] text-[var(--text-muted)] mt-1"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              Every handle bound on the Identity Registry, confirmed live with resolve
            </p>
            <p
              className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-accent)] mt-3"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              Browse handles →
            </p>
          </a>
        </div>
      </div>

      {/* Footer */}
      <footer className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-t border-[#1f1d19] px-8 py-4 md:px-14">
        <div
          className="text-[10px] uppercase tracking-[0.22em] text-[var(--text-muted)]"
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

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code
      className="px-1.5 py-0.5 bg-[#1f1d19] border border-[#3d3a33] text-[#b8b5a8] text-[13px]"
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      {children}
    </code>
  );
}
