import Link from 'next/link';
import { SignetMonogram } from '../..([XRcketing)/components/signet-monogram';

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

function Sub({ children }: { children: React.ReactNode }) {
  return (
    <h3
      className="mt-8 text-[13px] font-medium text-[#f5f4ee]"
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      {children}
    </h3>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="text-[#f5f4ee]">{children}</code>;
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
          Soroban requires a valid signature from that wallet&quot;s key, so a
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
          entry — come back unchanged. The procedure is public in {' '}
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

        <H>Reading a contract diagram</H>
        <p className="mt-4 text-[14px] leading-[1.7] text-[#b8b5a8]">
          The <strong>Diagram</strong> tab on a contract page draws the shape of a
          Soroban contract from its compiled spec and from on-chain activity:
          which functions exist, which events they emit, and which of those are
          actually being used. It is a map of interface and usage, not a look
          inside the contract&#8217;s storage.
        </p>

        <Sub>Node kinds</Sub>
        <ul className="mt-3 space-y-2 text-[14px] leading-[1.7] text-[#b8b5a8]">
          <li>
            <strong>Function node</strong> — one exported entry point from the
            contract spec. The label is the function name; the badge next to it
            shows how many times it was invoked on chain.
          </li>
          <li>
            <strong>Event node</strong> — an event the contract declares in its
            spec. Events are drawn with a distinct outline so they are not
            confused with callable functions.
          </li>
          <li>
            <strong>External node</strong> — a contract this one calls into or is called
            by, drawn at the edge of the graph with a muted treatment. External
            contracts are not expanded unless they also have a Signet diagram.
          </li>
        </ul>

        <Sub>Edge kinds</Sub>
        <ul className="mt-3 space-y-2 text-[14px] leading-[1.7] text-[#b8b5a8]">
          <li>
            <strong>Call edge</strong> — a solid line from a function to another
            function or external contract it invokes. Thickness reflects how often
            the call was observed on chain.
          </li>
          <li>
            <strong>Emit edge</strong> — a dashed line from a function to the event
            it emits. Dashing distinguishes &quot;this function produces this
            event&quot; from a function-to-function call.
          </li>
          <li>
            <strong>Inferred edge</strong> — a dotted line drawn from observed
            activity rather than from the spec. Inferred edges are labelled as
            such so you always know what the contract declares versus what it
            actually does.
          </li>
        </ul>

        <Sub>Groups and stubs</Sub>
        <p className="mt-3 text-[14px] leading-[1.7] text-[#b8b5a8]">
          Functions and events are clustered into <strong>groups</strong> by the
          convention in their names (e.g. a common prefix like <code>admin_</code>).
          Groups are a reading aid, not a language feature. When a function or event
          has no group match, it is drawn as a <strong>stub</strong> — a short
          labeled node with no edges, listed so nothing from the spec is hidden.
        </p>

        <Sub>Size thresholds</Sub>
        <p className="mt-3 text-[14px] leading-[1.7] text-[#b8b5a8]">
          Node size is driven by observed invocation counts, not by source code
          length. Nodes below the lower threshold are drawn at the minimum size;
          nodes above the upper threshold are capped so a single hot function
          does not dominate the layout. The thresholds are fixed per diagram, so
          two contracts can be compared by shape at a glance.
        </p>

        <Sub>SVG export</Sub>
        <p className="mt-3 text-[14px] leading-[1.7] text-[#b8b5a8]">
          The diagram can be downloaded as an SVG for use in docs, proposals or
          audits — the export is the same graph with the same legend, not a
          screenshot. Text remains selectable and the file is self-contained.
        </p>

        <Sub>What the diagram cannot show</Sub>
        <ul className="mt-3 space-y-2 text-[14px] leading-[1.7] text-[#b8b5a8]">
          <li>
            <strong>Mutability</strong> — the Soroban spec does not say whether a function
            writes state, only that it exists. A function that looks read-only may
            still mutate storage.
          </li>
          <li>
            <strong>State layout</strong> — the spec describes the interface, not the
            storage keys or the shape of what is stored. The diagram cannot tell
            you what a function will read or write.
          </li>
          <li>
            <strong>Authorization requirements</strong> — neither the spec nor
            observed activity shows which addresses are allowed to call a given
            function.
          </li>
          <li>
            <strong>Anything not observed yet</strong> — a function with no observed
            invocations is drawn but unsized. Absence of activity is not evidence
            that a function is dead — it may simply not be indexed yet.
          </li>
        </ul>

        <Sub>What &quot;observed&quot; means</Sub>
        <p className="mt-3 text-[14px] leading-[1.7] text-[#b8b5a8]">
          Today, &quot;observed&quot; means the invocations and events visible in
          Signet&#8217;s index of public chain activity. Once the phase 2/3
          indexer lands, every invocation and event for a contract will be
          attributed from the chain itself, so &quot;observed&quot; will mean &quot;every
          on-chain invocation Signet has indexed&quot; rather than &quot;what we have seen so
          far&quot;. Until then, treat the counts as a lower bound.
        </p>

        <H>Linking your deploy wallet</H>
        <p className="mt-4 text-[14px] leading-[1.7] text-[#b8b5a8]">
          Claiming a handle binds it to the wallet that signs the {' '}
          <code>claim</code> — usually a browser wallet, which is rarely the
          keystore identity you run <code>stellar contract deploy</code> from. To
          make a profile a real career record you link that deploy wallet from a
          terminal:
        </p>
        <pre
          className="mt-4 overflow-x-auto border border-[#1f1d19] bg-[#0e0d0b] px-5 py-4 text-[12px] leading-[1.7] text-[#b8b5a8]"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
{`npx @signet/cli link`}
        </pre>
        <p className="mt-4 text-[14px] leading-[1.7] text-[#b8b5a8]">
          The command proves control of the deploy key and associates it with
          your handle; the indexer then attributes every contract that wallet has
          deployed and invoked to your profile. This is the path from a claimed
          handle to an indexed profile — until a deploy wallet is linked, a
          claimed handle points at an address that has deployed nothing and the
          profile renders empty. <strong>Terminal linking is not live yet</strong>;
          the full sequence is specified in <code>docs/CLI.md</code>.
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
{ import { SignetClient } from '@signet/sdk';

const signet = new SignetClient({ baseUrl: 'https://your-deployment.example' });
const profile = await signet.getProfile('yourhandle');
// → { Handle, profile, stats: { invocations, uniqueFunctions } }`}
        </pre>

        <H>Phases</H>
        <ul className="mt-4 space-y-2 text-[14px] leading-[1.7] text-[#b8b5a8]">
          <li>
            <strong>Phase 1 (done):</strong> public profiles, real on-chain
            activity and the SDK. Its curated handle→wallet bindings have been
            retired — only handles bound on-chain are served.
          </li>
          <li>
            <strong>Phase 2 (live):</strong> self-sovereign claims via the
            on-chain Identity Registry, and the developer dashboard at{' '}
            <code>/app</code>.
          </li>
          <li>
            <strong>Phase 2 (in progress):</strong> terminal deploy-wallet
            linking (<code>npx @signet/cli link</code>) and the indexer
            populating full deployment history.
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
