'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { releaseHandle } from '@/lib/registry';
import { explainReleaseError } from '@/lib/registry-errors';
import { stellarExpertTxUrl } from '@/lib/network';
import { connectWallet, getConnectedAddress } from '@/lib/wallet';

interface ReleaseHandleSectionProps {
  handle: string;
  /** The registry the server reads the binding from. */
  registryContract?: string;
}

const mono = { fontFamily: 'var(--font-mono)' } as const;

/**
 * Releases the signed-in owner's handle on-chain (#898). The section only
 * renders for the handle's on-chain owner; the registry still checks the
 * signature, so a different connected wallet fails with a plain message.
 */
export function ReleaseHandleSection({ handle, registryContract }: ReleaseHandleSectionProps) {
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
      const wallet = (await getConnectedAddress()) ?? (await connectWallet());
      const result = await releaseHandle(handle, wallet, { contractId: registryContract });
      setTxHash(result.hash);
      // The handle-scoped views re-read the account and drop the handle.
      router.refresh();
    } catch (err) {
      setError(explainReleaseError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-10">
      <h2 className="text-[10px] uppercase tracking-[0.22em] text-[#c2410c]" style={mono}>
        Release @{handle}
      </h2>
      <p className="mt-2 max-w-[560px] text-[13px] leading-[1.7] text-[#8a8779]" style={mono}>
        Releasing removes the binding on-chain. The profile and its contract pages stop resolving,
        linked deploy wallets no longer count toward this handle, and anyone can claim the handle
        afterwards. Your wallet signs the release and pays a small network fee.
      </p>

      <div role="status" aria-live="polite">
        {txHash && (
          <div className="mt-5 max-w-[560px] border border-[#1f1d19] bg-[#0d0c0a] p-4" style={mono}>
            <p className="text-[13px] text-[#f5f4ee]">
              @{handle} released. The dashboard drops it once the release is indexed.
            </p>
            <a
              href={stellarExpertTxUrl(txHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-[12px] uppercase tracking-[0.18em] text-[var(--text-accent)] hover:underline"
            >
              View transaction on Stellar Expert ↗
            </a>
          </div>
        )}
      </div>

      {!txHash && (
        <div className="mt-5 max-w-[560px]">
          <label
            htmlFor="confirm-handle-input"
            className="block text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]"
            style={mono}
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
            style={mono}
          />

          {error && (
            <p role="alert" className="mt-2 text-[12px] text-[var(--text-accent)]" style={mono}>
              {error}
            </p>
          )}

          <div className="mt-4">
            <button
              type="button"
              onClick={handleRelease}
              disabled={!isExactMatch || busy}
              className="bg-[#c2410c] px-7 py-3 text-[12px] font-medium uppercase tracking-[0.18em] text-[#f5f4ee] transition-all duration-300 hover:bg-[#ea580c] disabled:opacity-40 disabled:hover:bg-[#c2410c]"
              style={mono}
            >
              {busy ? 'Releasing…' : `Release @${handle}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
