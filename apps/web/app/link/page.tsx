import type { Metadata } from 'next';
import { currentAddress } from '@/lib/server/session';
import { getAccount } from '@/lib/server/account';
import { describePairing } from '@/lib/server/pairing';
import { SignInGate } from '@/app/(dashboard)/components/sign-in-gate';
import { ApprovePanel } from './approve-panel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Approve CLI link · Signet',
  // A pairing code in a URL is not something to hand to a crawler, and there
  // is nothing on this page worth indexing anyway.
  robots: { index: false, follow: false },
};

const mono = { fontFamily: 'var(--font-mono)' } as const;
const display = { fontFamily: 'var(--font-display)' } as const;

const REFUSAL: Record<string, string> = {
  'not-found': 'That pairing code is not valid. Start the link again from your terminal.',
  expired: 'That pairing code has expired. Run `signet link` again to get a new one.',
  'already-used':
    'That pairing code has already been answered. Start a new one from your terminal.',
  unavailable: 'CLI linking is unavailable on this deployment — no database is configured.',
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-[720px] px-6 py-20 md:py-28">
      <p className="text-[10px] uppercase tracking-[0.28em] text-[#5e5b51]" style={mono}>
        Signet CLI
      </p>
      {children}
    </main>
  );
}

function Refusal({ message }: { message: string }) {
  return (
    <Shell>
      <h1
        className="mt-6 text-[40px] font-bold leading-[0.96] tracking-[-0.025em] md:text-[56px]"
        style={display}
      >
        Can’t approve this
      </h1>
      <p className="mt-6 max-w-[560px] text-[14px] leading-[1.7] text-[#8a8779]" style={mono}>
        {message}
      </p>
    </Shell>
  );
}

/**
 * `/link?code=…` — the human consent step of `signet link`.
 *
 * The CLI prints this URL; the developer opens it and sees the two things the
 * approval is actually about: which deploy account is about to be attached,
 * and which handle it will be attached to. Approving without being shown the
 * key is an approval in name only, which is the whole point of #267.
 *
 * The key rendered here is the one the CLI *declared* at `pair/start`. It is
 * not proof of anything by itself — but `completePairing` refuses to attach
 * any other account, so what is displayed is what gets bound.
 *
 * A code that cannot be verified is never rendered: an unknown, expired, or
 * already-answered pairing gets a refusal page, not a form.
 */
export default async function LinkApprovalPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;

  if (!code) {
    return (
      <Refusal message="This page needs a pairing code. Run `signet link` in your terminal to get one." />
    );
  }

  // Session first: the page must not disclose whether a code is real to
  // someone who is not signed in.
  const address = await currentAddress();
  if (!address) {
    return (
      <Shell>
        <p className="mt-6 max-w-[560px] text-[14px] leading-[1.7] text-[#8a8779]" style={mono}>
          Sign in to approve the terminal that is asking to link a deploy wallet to your handle.
        </p>
        <div className="mt-10">
          <SignInGate />
        </div>
      </Shell>
    );
  }

  const pairing = await describePairing(code);
  if (!pairing.ok) {
    return <Refusal message={REFUSAL[pairing.reason] ?? 'That pairing code cannot be used.'} />;
  }

  const account = await getAccount(address);
  if (!account.handle) {
    return (
      <Refusal message="Claim a handle before linking a deploy wallet — there is nothing to attach it to yet." />
    );
  }

  return (
    <Shell>
      <h1
        className="mt-6 text-[40px] font-bold leading-[0.96] tracking-[-0.025em] md:text-[56px]"
        style={display}
      >
        Approve this link
      </h1>

      <p className="mt-6 max-w-[560px] text-[14px] leading-[1.7] text-[#8a8779]" style={mono}>
        A terminal is asking to attach a deploy wallet to your handle. Contracts deployed from that
        wallet will be attributed to you. Approve only if you started this.
      </p>

      <dl className="mt-10 max-w-[640px] border border-[#1f1d19]">
        <div className="border-b border-[#1f1d19] px-6 py-5">
          <dt className="text-[10px] uppercase tracking-[0.2em] text-[#5e5b51]" style={mono}>
            Deploy wallet
          </dt>
          <dd className="mt-2 break-all text-[13px] text-[#b8b5a8]" style={mono}>
            {pairing.publicKey ??
              'Not declared by the CLI — update to a newer version to see it here'}
          </dd>
        </div>
        <div className="px-6 py-5">
          <dt className="text-[10px] uppercase tracking-[0.2em] text-[#5e5b51]" style={mono}>
            Handle
          </dt>
          <dd className="mt-2 text-[13px] text-[#b8b5a8]" style={mono}>
            @{account.handle}
          </dd>
        </div>
      </dl>

      <ApprovePanel state={pairing.state} />

      <p className="mt-10 max-w-[560px] text-[12px] leading-[1.7] text-[#5e5b51]" style={mono}>
        This code expires shortly after it was issued. If it runs out, run `signet link` again.
      </p>
    </Shell>
  );
}
