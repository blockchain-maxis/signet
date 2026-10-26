import Link from 'next/link';
import { currentAddress } from '@/lib/server/session';
import { getAccount } from '@/lib/server/account';
import { MAX_ACTIVE_API_KEYS } from '@/lib/server/account-api-keys';
import { ApiKeysManager } from './api-keys-manager';

const mono = { fontFamily: 'var(--font-mono)' } as const;
const display = { fontFamily: 'var(--font-display)' } as const;

/**
 * `/app/api-keys` (#652): the signed-in profile's keys for the public API's
 * keyed rate limit (#651). A wallet without a profile row on this deployment
 * gets an explanation instead of the form, since a key belongs to a profile.
 */
export default async function ApiKeysPage() {
  const address = await currentAddress();
  const account = address ? await getAccount(address) : null;

  return (
    <section>
      <h1
        className="text-[40px] font-bold leading-[0.96] tracking-[-0.025em] md:text-[56px]"
        style={display}
      >
        API keys
      </h1>
      <p className="mt-6 max-w-[620px] text-[14px] leading-[1.7] text-[#8a8779]">
        A key raises your rate limit on the{' '}
        <Link
          href="/docs/api"
          className="text-[var(--text-accent)] underline underline-offset-4"
        >
          public API
        </Link>
        . It unlocks no extra data: everything is readable without one. Send it as{' '}
        <code className="text-[#b8b5a8]" style={mono}>
          Authorization: Bearer sgk_…
        </code>{' '}
        from a server, never from a browser. Up to {MAX_ACTIVE_API_KEYS} keys can be active.
      </p>

      {account?.editable ? (
        <ApiKeysManager max={MAX_ACTIVE_API_KEYS} />
      ) : (
        <div
          className="mt-10 max-w-[640px] border border-[#1f1d19] px-6 py-6 text-[14px] leading-[1.7] text-[#b8b5a8]"
          role="note"
        >
          <p className="text-[#f5f4ee]">API keys need a profile on this deployment.</p>
          <p className="mt-2 text-[#8a8779]">
            {account?.handle
              ? `@${account.handle} is bound on-chain, but this deployment has not recorded the profile yet. It appears once the indexer has caught up; check back in a few minutes.`
              : 'Claim a handle first. A key belongs to the profile of the wallet you signed in with.'}
          </p>
          {!account?.handle && (
            <Link
              href="/#claim"
              className="mt-4 inline-block text-[11px] uppercase tracking-[0.22em] text-[var(--text-accent)]"
              style={mono}
            >
              Claim your handle
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
