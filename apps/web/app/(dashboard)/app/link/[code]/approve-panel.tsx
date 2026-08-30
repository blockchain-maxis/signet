'use client';

import { useEffect, useState } from 'react';

const mono = { fontFamily: 'var(--font-mono)' } as const;

/** Polls the page itself by reloading while the CLI hasn't proven its key yet, or the approval hasn't landed. */
export function AutoRefresh({ intervalMs = 3000 }: { intervalMs?: number }) {
  useEffect(() => {
    const id = setInterval(() => window.location.reload(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return null;
}

/** Approve button for a proven, pending pairing. Shows the one-time completion code on success. */
export function ApprovePanel({ pairingCode }: { pairingCode: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [completionCode, setCompletionCode] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/cli/pair/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingCode }),
      });
      const body = (await res.json()) as { completionCode?: string; error?: string };
      if (!res.ok || !body.completionCode) {
        throw new Error(body.error ?? 'Approval failed');
      }
      setCompletionCode(body.completionCode);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Approval failed');
    } finally {
      setBusy(false);
    }
  }

  if (completionCode) {
    return (
      <div className="mt-8 border border-[#1f1d19] px-6 py-6">
        <p className="text-[12px] uppercase tracking-[0.18em] text-emerald-500" style={mono}>
          Linked — your CLI has already been notified.
        </p>
        <p className="mt-4 text-[13px] leading-[1.7] text-[#8a8779]" style={mono}>
          If the terminal is still waiting, paste this code back into it instead:
        </p>
        <p className="mt-3 text-[24px] font-bold tracking-[0.1em]" style={mono}>
          {completionCode}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-8">
      <button
        type="button"
        onClick={approve}
        disabled={busy}
        className="bg-[#f5f4ee] px-7 py-3 text-[12px] font-medium uppercase tracking-[0.18em] text-[#0a0908] transition-all duration-300 hover:bg-[#c2410c] hover:text-[#f5f4ee] disabled:opacity-60"
        style={mono}
      >
        {busy ? 'Approving…' : 'Approve this link'}
      </button>
      {err && (
        <p className="mt-4 text-[12px] text-[#c2410c]" style={mono}>
          {err}
        </p>
      )}
    </div>
  );
}
