'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { releaseHandle } from '@/lib/registry';
import { explainReleaseError } from '@/lib/registry-errors';
import { stellarExpertTxUrl } from '@/lib/network';

interface ReleaseHandleSectionProps {
  handle: string;
  walletAddress: string;
}

export function ReleaseHandleSection({ handle, walletAddress }: ReleaseHandleSectionProps) {
  const router = useRouter();
  const [typedHandle, setTypedHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const isExactMatch = typedHandle === handle;

  async function handleRelease() {
    if (!isExactMatch || busy) return;
    setBusy(true);
    setError(null);

    try {
      const result = await releaseHandle(handle, walletAddress);
      setTxHash(result.hash);
      router.refresh();
    } catch (err) {
      setError(explainReleaseError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-10">
      <div
        className="text-[10px] uppercase tracking-[0.22em] text-[#c2410c]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        Release @{handle}
      </div>
      <p
        className="mt-2 max-w-[560px] text-[13px] leading-[1.7] text-[#8a8779]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        Releasing your handle removes the binding on-chain. The profile and its contract pages stop
        resolving, linked deploy wallets no longer count toward this handle, and anyone can claim
        the handle afterwards.
      </p>

      {txHash ? (
        <div
          className="mt-5 max-w-[560px] border border-[#1f1d19] bg-[#0d0c0a] p-4"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          <p className="text-[13px] text-[#f5f4ee]">Handle @{handle} released.</p>
          <a
            href={stellarExpertTxUrl(txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-[12px] uppercase tracking-[0.18em] text-[var(--text-accent)] hover:underline"
          >
            View transaction on StellarExpert ↗
          </a>
        </div>
      ) : (
        <div className="mt-5 max-w-[560px]">
          <label
            htmlFor="confirm-handle-input"
            className="block text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            Type <span className="text-[#f5f4ee]">{handle}</span> to confirm
          </label>
          <input
            id="confirm-handle-input"
            type="text"
            value={typedHandle}
            onChange={(e) => setTypedHandle(e.target.value)}
            placeholder={handle}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            className="mt-2 w-full border border-[#1f1d19] bg-[#0a0908] px-4 py-2.5 text-[13px] text-[#f5f4ee] placeholder-[#57534e] focus:border-[#c2410c] focus:outline-none"
            style={{ fontFamily: 'var(--font-mono)' }}
          />

          {error && (
            <p
              className="mt-2 text-[12px] text-[var(--text-accent)]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {error}
            </p>
          )}

          <div className="mt-4">
            <button
              type="button"
              onClick={handleRelease}
              disabled={!isExactMatch || busy}
              className="bg-[#c2410c] px-7 py-3 text-[12px] font-medium uppercase tracking-[0.18em] text-[#f5f4ee] transition-all duration-300 hover:bg-[#ea580c] disabled:opacity-40 disabled:hover:bg-[#c2410c]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {busy ? 'Releasing…' : `Release @${handle}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
