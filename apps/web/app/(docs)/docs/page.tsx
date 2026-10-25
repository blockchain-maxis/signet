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
      className="mt-14 text-[11px] uppercase tracking-[0.26em] text-[var(--text-accent)]"
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
          The <strong>Diagram</strong> tab on a contract page is a picture of a
          Soroban contract&#8217;s public interface, drawn from its compiled
          spec: which functions it exposes and which data types they take and
          return. Everything solid in it is <strong>declared</strong> by the
          contract. Anything dashed is <strong>observed</strong>: seen in
          transactions Signet indexed, never promised by the contract. The
          legend under each diagram lists exactly the shapes and lines it uses.
        </p>

        <Sub>Nodes</Sub>
        <ul className="mt-3 space-y-2 text-[14px] leading-[1.7] text-[#b8b5a8]">
          <li>
            <strong>Function</strong> (rounded box, <code>fn</code>): one
            exported function. It links to that function in the generated docs.
          </li>
          <li>
            <strong>Struct, enum and union</strong> (square box; a union has a
            cut corner): a data type the spec defines and a function uses. Types
            sit in columns to the right of the functions, nested types further
            right.
          </li>
          <li>
            <strong>Stub</strong> (dashed box): a type the spec names but does
            not define, linked to the docs instead of drawn.
          </li>
          <li>
            <strong>Collapsed group</strong> (dashed box such as 
            <code>pool_* (12)</code>): a group of functions folded into one box.
            Select it to draw its functions; a <strong>Collapse</strong> link
            folds it again.
          </li>
          <li>
            <strong>Contract</strong> (box ringed in the observed colour): another
            contract this one has been seen calling, named by its asset, its
            Signet profile, or its short address.
          </li>
        </ul>
        <p className="mt-3 text-[14px] leading-[1.7] text-[#b8b5a8]">
          Errors and events are not nodes. They relate to many functions at once,
          so they are listed in the docs tabs instead of adding lines here.
        </p>

        <Sub>Lines</Sub>
        <ul className="mt-3 space-y-2 text-[14px] leading-[1.7] text-[#b8b5a8]">
          <li>
            <strong>Argument</strong> (solid, filled arrow): the type is one of
            the function&#8217;s inputs.
          </li>
          <li>
            <strong>Return</strong> (solid, open arrow): the function gives the
            type back.
          </li>
          <li>
            <strong>Field</strong> (thin solid line): one type contains another.
          </li>
          <li>
            <strong>Call</strong> (dashed, dotted or dash-dot, with a count): this
            contract was seen calling another one. The pattern says how Signet
            knows: an authorisation tree, an event the other contract emitted, or
            only its presence in the transaction&#8217;s footprint. Thicker lines
            were seen more often.
          </li>
        </ul>
        <p className="mt-3 text-[14px] leading-[1.7] text-[#b8b5a8]">
          An argument merely named <code>token</code> or <code>pool</code> is
          never drawn as a relationship: only the types are.
        </p>

        <Sub>Groups</Sub>
        <p className="mt-3 text-[14px] leading-[1.7] text-[#b8b5a8]">
          Soroban contracts conventionally prefix related functions, for example 
          <code>admin_</code> or <code>pool_</code>. The diagram clusters
          functions that share a prefix into a group, with the well-known
          lifecycle entrypoints (<code>init</code>, <code>upgrade</code> and the
          like) in their own. A contract with more than 25 functions starts with
          every group collapsed. Grouping is a reading aid based on naming, not
          something the language enforces.
        </p>

        <Sub>When there is no diagram</Sub>
        <p className="mt-3 text-[14px] leading-[1.7] text-[#b8b5a8]">
          A diagram is only drawn when it adds something. A contract whose
          functions use no types of their own, such as the registry, gets no
          diagram, because its docs already say everything a picture could. A
          contract with more than 60 nodes after grouping gets the function list
          with a note that it is too large to diagram usefully. Text never
          renders smaller than 12px: a wide diagram scrolls inside its own box
          instead of shrinking.
        </p>

        <Sub>What is observed, and how far it reaches</Sub>
        <ul className="mt-3 space-y-2 text-[14px] leading-[1.7] text-[#b8b5a8]">
          <li>
            <strong>Read/write marks</strong>: a <code>W</code>, <code>R</code> 
            or <code>?</code> on a function says it was seen writing state, seen
            only reading, or never seen at all. <code>R</code> means no write was
            observed, not that the function cannot write.
          </li>
          <li>
            <strong>Activity</strong>: the line above the diagram and the count
            on each function come from indexed calls over the chosen range.
          </li>
          <li>
            <strong>Storage view</strong>: the storage keys the contract has been
            seen using, grouped as instance, persistent and temporary, with the
            functions that read and wrote them.
          </li>
        </ul>
        <p className="mt-3 text-[14px] leading-[1.7] text-[#b8b5a8]">
          Each of these says under it what it was built from: how many
          transactions, between which ledgers. Signet only sees calls made since
          it began indexing a contract, within the RPC&#8217;s retention window
          (about 7 days on testnet), and keeps a limited number per contract, so
          a quiet or new contract shows little, and that absence is not
          evidence.
        </p>

        <Sub>What the diagram cannot show</Sub>
        <ul className="mt-3 space-y-2 text-[14px] leading-[1.7] text-[#b8b5a8]">
          <li>
            <strong>Whether a function can write state</strong>: the spec does
            not say. A mark only reports what was seen.
          </li>
          <li>
            <strong>A storage schema</strong>: Soroban contracts do not declare
            one. The storage view lists keys seen in use, never the keys that
            could exist.
          </li>
          <li>
            <strong>Calls nobody made</strong>: call lines come from transactions,
            so a call path no one has used yet is not drawn.
          </li>
          <li>
            <strong>Which function emits which event</strong>: the spec declares
            events, not who raises them.
          </li>
        </ul>

        <Sub>Saving a diagram</Sub>
        <p className="mt-3 text-[14px] leading-[1.7] text-[#b8b5a8]">
          <strong>Download SVG</strong> saves the interface diagram with the
          contract&#8217;s address, network and WASM hash printed under it; 
          <strong>Download PNG</strong> saves the same at twice the size; the
          storage view has its own SVG download. Every diagram state is also a
          link: the URL keeps the search, the expanded groups, the activity range
          and a focused node.
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
            className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-accent)] transition-colors hover:text-[var(--text-accent)]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            How Signet works ↗
          </Link>
        </div>
      </main>
    </div>
  );
}
