'use client';

import { useState } from 'react';
import { signIn } from '@/lib/wallet';

/** Wallet sign-in wall for the dashboard (Sign-In With Stellar). */
export function SignInGate() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      await signIn();
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="max-w-[560px]">
      <h1
        className="text-[40px] font-bold leading-[0.96] tracking-[-0.025em] md:text-[56px]"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        Sign in
      </h1>
      <p className="mt-6 text-[14px] leading-[1.7] text-[#8a8779]">
        Connect your Stellar wallet and sign a one-time message to prove ownership. No
        transaction, no fees — just a signature.
      </p>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="mt-8 inline-flex items-center gap-3 bg-[#f5f4ee] px-7 py-4 text-[12px] font-medium uppercase tracking-[0.18em] text-[#0a0908] transition-all duration-300 hover:bg-[#c2410c] hover:text-[#f5f4ee] disabled:opacity-60"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {busy ? 'Signing…' : 'Sign in with wallet'}
        <span className="text-[#8b1a1a]">→</span>
      </button>
      {err && (
        <p className="mt-4 text-[12px] text-[var(--text-accent)]" style={{ fontFamily: 'var(--font-mono)' }}>
          {err}
        </p>
      )}
    </section>
  );
}
