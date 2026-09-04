'use client';

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';

type Status = 'loading' | 'ready' | 'no-profile' | 'error';

/**
 * Editor for the presentation fields of the signed-in wallet's public profile.
 * Loads the current values via `account.me` and saves through `account.update`
 * (both gated by the session cookie). When no profile is bound to the wallet
 * yet, it tells the user to claim a handle on-chain first instead of failing.
 *
 * Both calls go through the React Query tRPC hooks, so a successful save
 * invalidates the cached `account.me` and the surrounding dashboard refetches
 * the new values instead of holding stale ones.
 */
export function ProfileEditor() {
  const me = trpc.account.me.useQuery();
  const utils = trpc.useUtils();

  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  // Seed the form from the server once, the first time the query resolves;
  // later refetches (e.g. after a save) must not clobber in-flight edits.
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current || !me.data) return;
    seeded.current = true;
    if (!me.data.dbConfigured) {
      setMessage('Profile editing requires a configured database.');
      return;
    }
    setDisplayName(me.data.displayName ?? '');
    setBio(me.data.bio ?? '');
  }, [me.data]);

  const update = trpc.account.update.useMutation({
    onSuccess: (updated) => {
      setDisplayName(updated.displayName ?? '');
      setBio(updated.bio ?? '');
      setMessage('Saved.');
      // Refresh the cached profile so anything else reading it sees the edit.
      void utils.account.me.invalidate();
    },
    onError: (err) => setMessage(err.message || 'Could not save changes'),
  });

  const handle = me.data?.handle ?? null;
  const saving = update.isPending;
  // A handle can be resolved from the registry before the indexer has created
  // the profile row backing these fields — `editable`, not the handle, is what
  // says there is something here to write to.
  const status: Status = me.isError
    ? 'error'
    : me.isPending
      ? 'loading'
      : !me.data.dbConfigured
        ? 'error'
        : me.data.editable
          ? 'ready'
          : 'no-profile';

  function save(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    update.mutate({ displayName, bio });
  }

  if (status === 'loading') {
    return <p className="text-[14px] text-[#8a8779]">Loading…</p>;
  }
  if (status === 'error') {
    return (
      <p className="max-w-[640px] text-[14px] leading-[1.7] text-[#b8654a]">
        {message ?? 'Could not load your profile.'}
      </p>
    );
  }
  if (status === 'no-profile') {
    return (
      <p className="max-w-[640px] text-[14px] leading-[1.7] text-[#8a8779]">
        {handle ? (
          <>
            Handle <span className="text-[#b8b5a8]">@{handle}</span> is bound to this wallet
            on-chain, but the indexer hasn&apos;t created your profile record yet. Editing unlocks
            once the claim is synced.
          </>
        ) : (
          <>
            No profile is bound to this wallet yet. Claim a handle on-chain via the Identity
            Registry, and the indexer will create your profile — then you can edit it here.
          </>
        )}
      </p>
    );
  }

  const label = 'mb-2 block text-[11px] uppercase tracking-[0.18em] text-[#8a8779]';
  const field =
    'w-full border border-[#1f1d19] bg-transparent px-4 py-3 text-[14px] text-[#f5f4ee] outline-none focus:border-[#5e5b51]';

  return (
    <form
      onSubmit={save}
      className="max-w-[560px] space-y-7"
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      <p className="text-[13px] text-[#8a8779]">
        Editing <code className="text-[#b8b5a8]">/p/{handle}</code>
      </p>

      <div>
        <label htmlFor="displayName" className={label}>
          Display name
        </label>
        <input
          id="displayName"
          value={displayName}
          maxLength={80}
          onChange={(e) => setDisplayName(e.target.value)}
          className={field}
          placeholder={handle ?? ''}
        />
      </div>

      <div>
        <label htmlFor="bio" className={label}>
          Bio
        </label>
        <textarea
          id="bio"
          value={bio}
          maxLength={280}
          rows={4}
          onChange={(e) => setBio(e.target.value)}
          className={`${field} resize-none`}
        />
        <p className="mt-1 text-[11px] text-[#5e5b51]">{bio.length}/280</p>
      </div>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={saving}
          className="bg-[#f5f4ee] px-7 py-3 text-[12px] font-medium uppercase tracking-[0.18em] text-[#0a0908] transition-all duration-300 hover:bg-[#c2410c] hover:text-[#f5f4ee] disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {message && <span className="text-[12px] text-[#8a8779]">{message}</span>}
      </div>
    </form>
  );
}
