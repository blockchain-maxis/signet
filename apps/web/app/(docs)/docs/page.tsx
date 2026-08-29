import Link from 'next/link';
import { SignetMonogram } from '../../(marketing)/components/signet-monogram';

export const metadata = {
  title: 'Docs · Signet',
  description: 'How Signet binds Stellar wallets to developer identities, and how to read the data.',
};

function H({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="mt-14 text-[11px] uppercase tracking-[0.26em] text-[#8b1a1a]"
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      {children}
    </h2>
  );
}

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-[#0a0908] text-[#f5f4ee]">
      <nav className="flex items-center justify-between border-b border-[#1f1d19] px-8 py-6 md:px-14">
        <Link href="/" className="flex items-center gap-3">
          <SignetMonogram className="h-5 w-5 text-[#f5f4ee]" />
          <span className="text-[14px] font-medium tracking-tight">Signet</span>
        </Link>
        <Link
          href="/how-it-works"
          className="text-[11px] uppercase tracking-[0.22em] text-[#8a8779] transition-colors hover:text-[#f5f4ee]"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          How it works
        </Link>
      </nav>

      <main className="mx-auto max-w-3xl px-8 py-16 md:px-14">
        <h1
          className="text-[44px] font-bold leading-[0.96] tracking-[-0.025em] md:text-[64px]"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Documentation
        </h1>
        <p className="mt-6 max-w-[600px] text-[15px] leading-[1.7] text-[#8a8779]">
          Signet is a verifiable developer career record built on Stellar/Soroban.
          A handle is bound to a wallet on-chain; the contracts that wallet has
          deployed and invoked become a public, citable history.
        </p>

        <H>The trust model</H>
        <p className="mt-4 text-[14px] leading-[1.7] text-[#b8b5a8]">
          Bindings live in the <strong>Identity Registry</strong> Soroban contract
          (<code>packages/contracts/identity-registry</code>). To claim a handle,
          the wallet owner authorizes the <code>claim(handle, wallet)</code> call —
          Soroban requires a valid signature from that wallet&apos;s key, so a
          binding can only be created by the key holder. No trusted oracle, no
          off-chain admin minting identities.
        </p>

        <H>If the registry is ever replaced</H>
        <p className="mt-4 text-[14px] leading-[1.7] text-[#b8b5a8]">
          The registry contract is <strong>immutable</strong> — the same property
          that stops anyone rewriting the rule above also means a defect in it
          cannot be patched. Recovery is a new contract, and because a binding
          can only be created by the wallet that signs for it, bindings do not
          move across by decree: you would <strong>re-claim your handle</strong>{' '}
          on the new registry with one signature. Your handle is held for your
          wallet during a grace period, so the move is not a race, and your
          profile and history — both derived from the wallet, not the registry
          entry — come back unchanged. The procedure is public in{' '}
          <code>docs/CONTRACT_MIGRATION.md</code>.
        </p>

        <H>Reading a profile</H>
        <p className="mt-4 text-[14px] leading-[1.7] text-[#b8b5a8]">
          Every profile lives at{' '}
          <code className="text-[#f5f4ee]">/p/&#123;handle&#125;</code>. The
          on-chain operations shown are fetched from the public Stellar Horizon
          API, and each row links to its transaction on Stellar Expert for
          independent verification.
        </p>

        <H>SDK</H>
        <p className="mt-4 text-[14px] leading-[1.7] text-[#b8b5a8]">
          Integrators read profiles through <code>@signet/sdk</code>, which talks
          to the public API:
        </p>
        <pre
          className="mt-4 overflow-x-auto border border-[#1f1d19] bg-[#0e0d0b] px-5 py-4 text-[12px] leading-[1.7] text-[#b8b5a8]"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
{`import { SignetClient } from '@signet/sdk';

const signet = new SignetClient({ baseUrl: 'https://your-deployment.example' });
const profile = await signet.getProfile('aquawolf');
// → { handle, profile, stats: { invocations, uniqueFunctions } }`}
        </pre>

        <H>Phases</H>
        <ul className="mt-4 space-y-2 text-[14px] leading-[1.7] text-[#b8b5a8]">
          <li>
            <strong>Phase 1 (live):</strong> curated handle→wallet bindings, real
            on-chain activity, public profiles and SDK.
          </li>
          <li>
            <strong>Phase 2 (live):</strong> self-sovereign claims via the
            on-chain Identity Registry, and the developer dashboard at{' '}
            <code>/app</code>.
          </li>
          <li>
            <strong>Phase 2 (in progress):</strong> the indexer populating full
            deployment history.
          </li>
        </ul>

        <div className="mt-16 border-t border-[#1f1d19] pt-6">
          <Link
            href="/how-it-works"
            className="text-[11px] uppercase tracking-[0.22em] text-[#8b1a1a] transition-colors hover:text-[#c2410c]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            How Signet works ↗
          </Link>
        </div>
      </main>
    </div>
  );
}
