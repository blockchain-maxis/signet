'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { connectWallet, getConnectedAddress } from '@/lib/wallet';
import { restoreHandleBinding } from '@/lib/registry';
import { stellarExpertTxUrl } from '@/lib/network';

interface RestoreBindingProps {
  handle: string;
  className?: string;
}

export function RestoreBinding({ handle, className }: RestoreBindingProps) {
  const router = useRouter();
  const [state, setState] = useState<
    'idle' | 'connecting' | 'restoring' | 'polling' | 'success' | 'error'
  >('idle');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleRestore() {
    setErrorMessage(null);
    try {
      let wallet = await getConnectedAddress();
      if (!wallet) {
        setState('connecting');
        wallet = await connectWallet();
      }
      if (!wallet) {
        setState('idle');
        return;
      }

      setState('restoring');
      const res = await restoreHandleBinding(handle, wallet);
      setTxHash(res.hash);
      setState('polling');

      // Poll GET /api/v1/resolve/{handle} until it no longer reports archived
      const pollStart = Date.now();
      const pollInterval = 1500;
      const timeout = 60000;

      while (Date.now() - pollStart < timeout) {
        await new Promise((r) => setTimeout(r, pollInterval));
        try {
          const resp = await fetch(`/api/v1/resolve/${encodeURIComponent(handle)}`);
          if (resp.ok) {
            const data = (await resp.json()) as { archived?: boolean };
            if (!data.archived) {
              setState('success');
              router.refresh();
              return;
            }
          }
        } catch {
          // ignore transient poll error
        }
      }

      setState('success');
      router.refresh();
    } catch (err: unknown) {
      setState('error');
      const msg = err instanceof Error ? err.message : String(err);
      if (/reject|cancel|decline|denied/i.test(msg)) {
        setErrorMessage('Transaction signature was rejected.');
      } else if (/unfunded|underfunded|insufficient|not found|404/i.test(msg)) {
        setErrorMessage('Connected account is unfunded or has insufficient balance.');
      } else {
        setErrorMessage(`Restore submission failed: ${msg}`);
      }
    }
  }

  const isBusy = state === 'connecting' || state === 'restoring' || state === 'polling';

  return (
    <div className={className}>
      <p
        className="mb-3 text-[12px] leading-[1.6] text-[#b8b5a8]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        The connected wallet pays a small network fee. Ownership does not change.
      </p>

      <button
        type="button"
        onClick={handleRestore}
        disabled={isBusy || state === 'success'}
        className="inline-flex items-center justify-center border border-[#3a352a] bg-[#1a1815] px-4 py-2 text-[12px] font-medium uppercase tracking-[0.18em] text-[#f5f4ee] transition-colors hover:border-[var(--text-accent)] hover:text-[var(--text-accent)] disabled:cursor-not-allowed disabled:opacity-50"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {state === 'connecting'
          ? 'Connecting wallet…'
          : state === 'restoring'
            ? 'Restoring binding…'
            : state === 'polling'
              ? 'Confirming on-chain…'
              : state === 'success'
                ? 'Binding restored'
                : 'Restore binding'}
      </button>

      <div role="status" aria-live="polite" className="mt-3">
        {state === 'restoring' && (
          <p
            className="text-[12px] text-[#8a8779]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            Restoring binding on-chain…
          </p>
        )}
        {(state === 'polling' || state === 'success') && (
          <div className="space-y-1">
            <p
              className="text-[12px] text-emerald-400"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {state === 'success'
                ? 'Binding restored successfully.'
                : 'Restore submitted. Waiting for confirmation…'}
            </p>
            {txHash && (
              <a
                href={stellarExpertTxUrl(txHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block text-[11px] uppercase tracking-[0.18em] text-[var(--text-accent)] transition-colors hover:underline"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                View transaction on Stellar Expert ↗
              </a>
            )}
          </div>
        )}
        {state === 'error' && errorMessage && (
          <p
            className="text-[12px] text-red-400"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {errorMessage}
          </p>
        )}
      </div>
    </div>
  );
}
