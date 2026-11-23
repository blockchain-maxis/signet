import type { ReactNode } from 'react';
import { formatDate, formatTimeUntil } from '@/lib/format-date';
import { currentAddress, currentSessionClaims } from '@/lib/server/session';
import { getAccount } from '@/lib/server/account';
import { SignOutButton } from './sign-out-button';
import { SignOutOthersButton } from './sign-out-others-button';
import { ReleaseHandleSection } from './release-handle-section';

const mono = { fontFamily: 'var(--font-mono)' } as const;
const display = { fontFamily: 'var(--font-display)' } as const;

export default async function SettingsPage() {
  const address = await currentAddress();
  const [account, session] = address
    ? await Promise.all([getAccount(address), currentSessionClaims()])
    : [null, null];
  const sessionTimes = session && {
    signedInAt: new Date(session.iat).toISOString(),
    expiresAt: new Date(session.exp).toISOString(),
    remaining: formatTimeUntil(session.exp, Date.now()),
  };
  const showRelease = Boolean(address && account?.handle && account?.isPrimary);

  return (
    <section>
      <h1
        className="text-[40px] font-bold leading-[0.96] tracking-[-0.025em] md:text-[56px]"
        style={display}
      >
        Settings
      </h1>

      <div
        className="mt-8 max-w-[640px] divide-y divide-[#1f1d19] border border-[#1f1d19]"
        style={mono}
      >
        <Row label="Wallet" value={address ?? '—'} />
        <Row label="Handle" value={account?.handle ? `@${account.handle}` : 'Not claimed'} />
        <Row
          label="Session"
          value={
            sessionTimes ? (
              <>
                Active · expires <SessionDate dateTime={sessionTimes.expiresAt} /> (
                {sessionTimes.remaining})
              </>
            ) : (
              '—'
            )
          }
        />
        {sessionTimes && (
          <Row label="Signed in" value={<SessionDate dateTime={sessionTimes.signedInAt} />} />
        )}
      </div>

      <div className="mt-8">
        <div
          className="text-[10px] uppercase tracking-[0.22em] text-[var(--text-muted)]"
          style={mono}
        >
          End session
        </div>
        <p className="mt-2 max-w-[560px] text-[13px] leading-[1.7] text-[#8a8779]" style={mono}>
          Signing out clears your session cookie and disconnects the wallet on this device.
        </p>
        <div className="mt-5">
          <SignOutButton />
        </div>
      </div>

      <div className="mt-10">
        <div
          className="text-[10px] uppercase tracking-[0.22em] text-[var(--text-muted)]"
          style={mono}
        >
          Other devices
        </div>
        <p className="mt-2 max-w-[560px] text-[13px] leading-[1.7] text-[#8a8779]" style={mono}>
          Signs this wallet out of every other browser and device, and leaves this one signed in.
          Use it if you signed in somewhere you no longer control. Anything signed out this way has
          to sign the challenge again to come back.
        </p>
        <div className="mt-5">
          <SignOutOthersButton />
        </div>
      </div>

      {showRelease && account?.handle && address && (
        <ReleaseHandleSection handle={account.handle} walletAddress={address} />
      )}
    </section>
  );
}

function SessionDate({ dateTime }: { dateTime: string }) {
  return <time dateTime={dateTime}>{formatDate(dateTime, { timeZone: 'UTC' })}</time>;
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
      <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--text-muted)]">
        {label}
      </span>
      <span className="break-all text-[13px] text-[#b8b5a8]">{value}</span>
    </div>
  );
}
