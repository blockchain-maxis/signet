'use client';

import { useState } from 'react';

/**
 * The single action that completes a `signet link` pairing: the developer
 * clicks Approve, this POSTs to the approve endpoint, and the CLI's next poll
 * sees the state flip from pending to approved. All outcomes are surfaced
 * inline — including expiry, which the CLI stops waiting on at the same TTL.
 */
export function ApproveButton({ code }: { code: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setState('busy');
    setError(null);
    try {
      const res = await fetch('/api/link/device/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Approval failed (${res.status})`);
        setState('failed');
        return;
      }
      setState('done');
    } catch {
      setError('Could not reach the server — try again.');
      setState('failed');
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={approve}
        disabled={state === 'busy' || state === 'done'}
        aria-label={state === 'done' ? 'Approved' : 'Approve this link'}
        className="bg-[#8b1a1a] px-6 py-3 text-[11px] uppercase tracking-[0.22em] text-[#f5f4ee] transition-colors hover:bg-[#c2410c] disabled:cursor-not-allowed disabled:opacity-50"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {state === 'busy' ? 'Approving…' : state === 'done' ? 'Approved ✓' : 'Approve link'}
      </button>
      {state === 'done' && (
        <p role="status" className="mt-4 text-[13px] text-emerald-400">
          Approved. You can close this tab — the CLI picks it up on its next poll.
        </p>
      )}
      {state === 'failed' && (
        <p role="alert" className="mt-4 text-[13px] text-[#c2410c]">
          {error}
        </p>
      )}
    </div>
  );
}