import type { Metadata } from 'next';
import { currentAddress } from '@/lib/server/session';
import { getAccount } from '@/lib/server/account';
import { describePairing } from '@/lib/server/pairing';
import { getConfiguredNetwork } from '@/lib/cli-link';
import { normalizeNetwork } from '@signet/types';
import { safeCallbackUrl } from '@/lib/loopback-callback';
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
  'no-key':
    'The terminal that started this link never declared which deploy wallet it wants to attach, so there is nothing safe to approve. Start the link again from an up-to-date CLI.',
  'code-mismatch':
    'This link does not match the confirmation code your terminal was given. Open the exact URL `signet link` printed — if you did, run it again to start over.',
  unavailable:
    'CLI linking needs a database and this deployment has none configured, so nothing could be saved even if you approved. This is the operator’s configuration to fix, not yours.',
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0a0908] text-[#f5f4ee]">
      <main className="mx-auto max-w-[720px] px-6 py-20 md:py-28">
        <p
          className="text-[10px] uppercase tracking-[0.28em] text-[var(--text-muted)]"
          style={mono}
        >
          Signet CLI
        </p>
        {children}
      </main>
    </div>
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
 * already-answered pairing gets a refusal page, not a form. So does one whose
 * `user_code` (#596) does not hash to what `start` stored — the code is the
 * proof that this page was opened from the URL the developer's own terminal
 * printed, and it is displayed so they can compare it against the terminal
 * before approving.
 */
export default async function LinkApprovalPage({
  searchParams,
}: {
  searchParams: Promise<{
    code?: string;
    user_code?: string;
    callback?: string;
    callback_state?: string;
  }>;
}) {
  const { code, user_code: userCode, callback, callback_state: callbackState } = await searchParams;

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

  const pairing = await describePairing(code, userCode);
  if (!pairing.ok) {
    return <Refusal message={REFUSAL[pairing.reason] ?? 'That pairing code cannot be used.'} />;
  }

  const account = await getAccount(address);
  if (!account.handle) {
    return (
      <Refusal message="Claim a handle before linking a deploy wallet — there is nothing to attach it to yet." />
    );
  }

  // The network the CLI declared vs the one this deployment serves (#617).
  // `start` already refuses a mismatch, so this only fires when the
  // deployment's configuration changed mid-pairing — but a page that would
  // render an Approve button for the wrong network is not worth the race.
  const configuredNetwork = normalizeNetwork(getConfiguredNetwork());
  const isMainnet = pairing.network === 'mainnet';
  if (pairing.network !== configuredNetwork) {
    return (
      <Refusal
        message={`This pairing is for ${pairing.network}, but this deployment serves ${configuredNetwork}. Nothing can be safely approved here — run \`signet link\` again against the right deployment.`}
      />
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
        wallet will be attributed to you. Only approve if you just ran `signet link` in your own
        terminal.
      </p>

      <dl className="mt-10 max-w-[640px] border border-[#1f1d19]">
        <div className="border-b border-[#1f1d19] px-6 py-5">
          <dt
            className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)]"
            style={mono}
          >
            Deploy wallet
          </dt>
          <dd className="mt-2 break-all text-[13px] text-[#b8b5a8]" style={mono}>
            {pairing.publicKey}
          </dd>
        </div>
        <div className="border-b border-[#1f1d19] px-6 py-5">
          <dt
            className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)]"
            style={mono}
          >
            Handle
          </dt>
          <dd className="mt-2 text-[13px] text-[#b8b5a8]" style={mono}>
            @{account.handle}
          </dd>
        </div>
        <div
          className={`border-b px-6 py-5 ${isMainnet ? 'border-[#8b1a1a] bg-[#1a0d0a]' : 'border-[#1f1d19]'}`}
        >
          <dt
            className={`text-[10px] uppercase tracking-[0.2em] ${isMainnet ? 'text-[var(--text-accent)]' : 'text-[var(--text-muted)]'}`}
            style={mono}
          >
            Network
          </dt>
          <dd
            className={`mt-2 text-[13px] uppercase tracking-[0.1em] ${isMainnet ? 'text-[var(--text-accent)]' : 'text-[#b8b5a8]'}`}
            style={mono}
          >
            {pairing.network}
          </dd>
          {isMainnet && (
            <dd className="mt-2 text-[12px] leading-[1.7] text-[var(--text-accent)]" style={mono}>
              This is mainnet. Contracts attributed through this wallet are real deployments with
              real funds behind them — read the key above before approving.
            </dd>
          )}
        </div>
        <div className="px-6 py-5">
          <dt
            className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)]"
            style={mono}
          >
            Does your terminal show this code?
          </dt>
          <dd className="mt-2 text-[20px] tracking-[0.3em] text-[#b8b5a8]" style={mono}>
            {userCode}
          </dd>
          <dd className="mt-2 text-[12px] leading-[1.7] text-[var(--text-muted)]" style={mono}>
            `signet link` printed this code next to the URL. If your terminal shows a different one,
            close this page — you are not looking at your own link.
          </dd>
        </div>
      </dl>

      <ApprovePanel
        state={pairing.state}
        publicKey={pairing.publicKey}
        expiresAt={pairing.expiresAt}
        callback={safeCallbackUrl(callback)}
        callbackState={callbackState ?? null}
      />

      <p
        className="mt-10 max-w-[560px] text-[12px] leading-[1.7] text-[var(--text-muted)]"
        style={mono}
      >
        This code expires shortly after it was issued. If it runs out, run `signet link` again.
      </p>
    </Shell>
  );
}
