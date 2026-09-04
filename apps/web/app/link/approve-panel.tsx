'use client';

import { useState } from 'react';

type State =
  | { status: 'idle' }
  | { status: 'busy'; action: 'approve' | 'reject' }
  | { status: 'done'; action: 'approve' | 'reject' }
  | { status: 'error'; message: string };

const mono = { fontFamily: 'var(--font-mono)' } as const;

/**
 * Approve / reject for a pending CLI pairing.
 *
 * Both outcomes are explicit buttons rather than approve-plus-close-the-tab:
 * a refusal that is recorded lets the CLI exit immediately saying it was
 * refused, where an abandoned tab leaves it polling to the TTL with nothing to
 * report.
 */
export function ApprovePanel({ state }: { state: string }) {
  const [ui, setUi] = useState<State>({ status: 'idle' });

  async function send(action: 'approve' | 'reject') {
    setUi({ status: 'busy', action });
    try {
      const res = await fetch(`/api/cli/pair/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setUi({ status: 'error', message: body.error ?? 'Something went wrong' });
        return;
      }
      setUi({ status: 'done', action });
    } catch {
      setUi({ status: 'error', message: 'Could not reach the server' });
    }
  }

  if (ui.status === 'done') {
    return (
      <p
        className={`mt-8 text-[13px] leading-[1.7] ${
          ui.action === 'approve' ? 'text-[#4d7c3f]' : 'text-[#8a8779]'
        }`}
        style={mono}
      >
        {ui.action === 'approve'
          ? 'Approved. Return to your terminal — the CLI is finishing the link.'
          : 'Rejected. Nothing was linked. You can close this tab.'}
      </p>
    );
  }

  const busy = ui.status === 'busy';

  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => send('approve')}
          disabled={busy}
          className="inline-flex items-center gap-3 bg-[#f5f4ee] px-7 py-4 text-[12px] font-medium uppercase tracking-[0.18em] text-[#0a0908] transition-all duration-300 hover:bg-[#c2410c] hover:text-[#f5f4ee] disabled:opacity-60"
          style={mono}
        >
          {busy && ui.action === 'approve' ? 'Approving…' : 'Approve'}
          <span className="text-[#8b1a1a]">→</span>
        </button>
        <button
          type="button"
          onClick={() => send('reject')}
          disabled={busy}
          className="text-[12px] uppercase tracking-[0.18em] text-[#8a8779] transition-colors hover:text-[#8b1a1a] disabled:opacity-60"
          style={mono}
        >
          {busy && ui.action === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>
      {ui.status === 'error' && (
        <p className="mt-4 text-[12px] text-[#c2410c]" style={mono}>
          {ui.message}
        </p>
      )}
    </div>
  );
}
