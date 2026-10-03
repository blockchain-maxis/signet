import Link from 'next/link';
import { SignetMonogram } from '../../(marketing)/components/signet-monogram';

export const metadata = {
  title: 'Docs · Signet',
  description: 'How Signet binds Stellar wallets to developer identities, and how to read the data.',
};

function H({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
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

        <H id="reading-a-contract-diagram">Reading a contract diagram</H>
        <p className="mt-4 text-[14px] leading-[1.7] text-[#b8b5a8]">
          The contract diagram is a picture of a Soroban contract&#8217;s public
          interface, drawn from its compiled spec. It is 
          <strong>not live yet</strong>: the <strong>Diagram</strong> tab on a
          contract page is a placeholder while the drawing code is built, so
          this section describes what the diagram is designed to show and how
          to read it once it ships. The design is in{' '}
          <code>docs/CONTRACT_VISUALISER_DESIGN.md</code>.
        </p>

        <Sub>Nodes</Sub>
        <ul className="mt-3 space-y-2 text-[14px] leading-[1.7] text-[#b8b5a8]">
          <li>
            <strong>Function node</strong> — one exported function from the
            contract spec, labelled with its name and linking to that
            function&#8217;s entry in the generated docs.
          </li>
          <li>
            <strong>Type node</strong> — a struct, enum or union the spec
            defines and a function refers to. Types sit in a second column to the
            right of the functions.
          </li>
        </ul>
        <p className="mt-3 text-[14px] leading-[1.7] text-[#b8b5a8]">
          Errors and events are not nodes. They are listed below the diagram,
          because they relate to many functions at once and drawing them as
          nodes would add lines without adding meaning.
        </p>

        <Sub>Edges</Sub>
        <p className="mt-3 text-[14px] leading-[1.7] text-[#b8b5a8]">
          Every edge is an arrow drawn from the spec alone. An arrow from a
          function to a type means the type appears in the function&#8217;s
          arguments or return value; an arrow from one type to another means it
          appears as a field. Signet does not draw call arrows between
          contracts yet, and an argument that is merely named{' '}
          <code>token</code> or <code>pool</code> is never drawn as a
          relationship.
        </p>

        <Sub>Groups</Sub>
        <p className="mt-3 text-[14px] leading-[1.7] text-[#b8b5a8]">
          Soroban contracts conventionally prefix related functions (for
          example <code>admin_</code> or <code>pool_</code>). The diagram
          clusters functions that share a prefix into a <strong>group</strong>,
          which can collapse so a large contract stays scannable. Grouping is a
          reading aid based on naming, not something the language enforces.
        </p>

        <Sub>When there is no diagram</Sub>
        <p className="mt-3 text-[14px] leading-[1.7] text-[#b8b5a8]">
          A diagram is only drawn when it adds something. A contract with no
          spec-derived edges, such as the registry, gets no diagram because the
          generated docs already say everything it could. A contract with more
          than about 60 nodes after grouping gets the grouped function list
          with a note that its surface is too large to diagram usefully. Text
          never renders smaller than 12px; a wide diagram scrolls inside its
          own box instead of shrinking.
        </p>

        <Sub>What the diagram cannot show</Sub>
        <ul className="mt-3 space-y-2 text-[14px] leading-[1.7] text-[#b8b5a8]">
          <li>
            <strong>Mutability</strong> — the Soroban spec does not say whether
            a function writes state, only that it exists. A function that looks
            read-only may still mutate storage.
          </li>
          <li>
            <strong>State layout</strong> — the spec describes the interface,
            not storage keys or what is stored.
          </li>
          <li>
            <strong>Calls to other contracts</strong> — the spec lists what a
            contract exposes, not what it invokes.
          </li>
          <li>
            <strong>Which function emits which event</strong> — the spec
            declares events, not who raises them.
          </li>
        </ul>
        <p className="mt-3 text-[14px] leading-[1.7] text-[#b8b5a8]">
          The design adds a read/write mark and a cross-contract call graph in
          later phases, from simulation and from Signet&#8217;s indexer. Those
          are marked as observed rather than declared, and are not available
          today.
        </p>

        <H>Linking your deploy wallet</H>
        <p className="mt-4 text-[14px] leading-[1.7] text-[#b8b5a8]">
          Claiming a handle binds it to the wallet that signs the{' '}
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
{`import { SignetClient } from '@signet/sdk';

const signet = new SignetClient({ baseUrl: 'https://your-deployment.example' });
const profile = await signet.getProfile('yourhandle');
// → { handle, profile, stats: { invocations, uniqueFunctions } }`}
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
