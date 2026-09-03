'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc';

type State = { status: 'idle' | 'confirming' } | { status: 'error'; message: string };

const mono = { fontFamily: 'var(--font-mono)' } as const;

/**
 * Removes a non-primary wallet from the caller's own profile. Two-step
 * confirm (Unlink → Confirm/Cancel) instead of a native `confirm()` dialog, to
 * match the rest of the dashboard's styling. The primary wallet is never
 * offered this button — see `wallets/page.tsx` — since unlinking it is a
 * registry operation the server refuses anyway.
 */
export function UnlinkWalletButton({ pubkey }: { pubkey: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: 'idle' });
  const utils = trpc.useUtils();

  const unlink = trpc.account.unlinkWallet.useMutation({
    onSuccess: () => {
      // The wallet list is server-rendered, so refresh the route; also drop the
      // cached `account.me` in case a client surface is holding the old set.
      void utils.account.me.invalidate();
      router.refresh();
    },
    onError: (err) =>
      setState({ status: 'error', message: err.message || 'Could not unlink wallet' }),
  });

  function confirmUnlink() {
    // Leave the confirm prompt as the request goes out so the trigger below
    // renders the pending label, matching the previous two-step behaviour.
    setState({ status: 'idle' });
    unlink.mutate({ wallet: pubkey });
  }

  if (state.status === 'confirming') {
    return (
      <span className="flex items-center gap-3 text-[10px] uppercase tracking-[0.2em]" style={mono}>
        <span className="text-[#8a8779]">Unlink this wallet?</span>
        <button
          type="button"
          onClick={confirmUnlink}
          className="text-[#8b1a1a] transition-colors hover:text-[#c2410c]"
        >
          Confirm
        </button>
        <button
          type="button"
          onClick={() => setState({ status: 'idle' })}
          className="text-[#5e5b51] transition-colors hover:text-[#b8b5a8]"
        >
          Cancel
        </button>
      </span>
    );
  }

  if (state.status === 'error') {
    return (
      <span className="flex items-center gap-3 text-[10px] uppercase tracking-[0.2em]" style={mono}>
        <span className="text-[#8b1a1a]">{state.message}</span>
        <button
          type="button"
          onClick={() => setState({ status: 'idle' })}
          className="text-[#5e5b51] transition-colors hover:text-[#b8b5a8]"
        >
          Dismiss
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setState({ status: 'confirming' })}
      disabled={unlink.isPending}
      className="text-[10px] uppercase tracking-[0.2em] text-[#5e5b51] transition-colors hover:text-[#8b1a1a] disabled:opacity-60"
      style={mono}
    >
      {unlink.isPending ? 'Unlinking…' : 'Unlink'}
    </button>
  );
}
