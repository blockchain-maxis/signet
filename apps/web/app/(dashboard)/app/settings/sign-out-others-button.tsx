'use client';

import { useState } from 'react';
import { signOutOtherSessions } from '@/lib/wallet';

type State = { status: 'idle' | 'busy' | 'done' } | { status: 'error'; message: string };

/**
 * Signs the wallet out everywhere except this browser. Stays on the page — the
 * whole point is that this session survives — so the outcome is reported
 * inline rather than by a reload.
 */
export function SignOutOthersButton() {
  const [state, setState] = useState<State>({ status: 'idle' });

  async function go() {
    setState({ status: 'busy' });
    try {
      await signOutOtherSessions();
      setState({ status: 'done' });
    } catch (err) {
      setState({ status: 'error', message: (err as Error).message });
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={go}
        disabled={state.status === 'busy'}
        className="border border-[#3a3730] px-7 py-3 text-[12px] font-medium uppercase tracking-[0.18em] text-[#f5f4ee] transition-all duration-300 hover:border-[#c2410c] hover:text-[#c2410c] disabled:opacity-60"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {state.status === 'busy' ? 'Signing out…' : 'Sign out other devices'}
      </button>
      {state.status === 'done' && (
        <p className="mt-3 text-[12px] text-[#8a8779]" style={{ fontFamily: 'var(--font-mono)' }}>
          Other devices signed out. They lose access within ten seconds.
        </p>
      )}
      {state.status === 'error' && (
        <p className="mt-3 text-[12px] text-[#c2410c]" style={{ fontFamily: 'var(--font-mono)' }}>
          {state.message}
        </p>
      )}
    </div>
  );
}
