'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { connectWallet, getConnectedAddress } from '@/lib/wallet';
import { RegistryNotConfiguredError, restoreHandleBinding } from '@/lib/registry';
import { stellarExpertTxUrl } from '@/lib/network';

interface RestoreBindingProps {
  handle: string;
  /** The registry the server read the archived state from (#897). */
  registryContract?: string;
  className?: string;
}

type Phase = 'idle' | 'connecting' | 'restoring' | 'polling' | 'restored' | 'unconfirmed' | 'error';

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 60_000;

const mono = { fontFamily: 'var(--font-mono)' } as const;

/** Whether `/api/v1/resolve/{handle}` answers with a live binding again. */
async function isLiveAgain(handle: string): Promise<boolean> {
  try {
    const resp = await fetch(`/api/v1/resolve/${encodeURIComponent(handle)}`, {
      cache: 'no-store',
    });
    if (!resp.ok) return false;
    // Every v1 answer is wrapped in `{ data }`.
    const json = (await resp.json()) as { data?: { archived?: boolean; wallet?: string } };
    return json.data?.archived !== true && Boolean(json.data?.wallet);
  } catch {
    return false;
  }
}

/** A plain message for a failed restore. */
function describeError(err: unknown): string {
  if (err instanceof RegistryNotConfiguredError) {
    return 'This deployment is not configured against an Identity Registry, so it cannot restore bindings.';
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/reject|cancel|decline|denied/i.test(msg)) {
    return 'The signature was rejected in your wallet. Nothing was submitted.';
  }
  if (/account not found|unfunded|underfunded|insufficient/i.test(msg)) {
    return 'The connected account is not funded on this network, so it cannot pay the restore fee.';
  }
  return 'The restore could not be submitted. Try again in a moment.';
}

/**
 * Restores an archived handle binding (#897). The connected wallet pays the
 * fee; a restore changes no ownership, so any account may do it.
 */
export function RestoreBinding({ handle, registryContract, className }: RestoreBindingProps) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleRestore() {
    setErrorMessage(null);
    setTxHash(null);
    try {
      let wallet = await getConnectedAddress();
      if (!wallet) {
        setPhase('connecting');
        wallet = await connectWallet();
      }
      if (!wallet) {
        setPhase('idle');
        return;
      }

      setPhase('restoring');
      const { hash } = await restoreHandleBinding(handle, wallet, {
        contractId: registryContract,
      });
      setTxHash(hash);
      setPhase('polling');

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (await isLiveAgain(handle)) {
          setPhase('restored');
          router.refresh();
          return;
        }
      }
      // Submitted but not observed: never reported as a success.
      setPhase('unconfirmed');
    } catch (err: unknown) {
      setPhase('error');
      setErrorMessage(describeError(err));
    }
  }

  const busy = phase === 'connecting' || phase === 'restoring' || phase === 'polling';

  return (
    <div className={className}>
      <p className="mb-3 text-[12px] leading-[1.6] text-[#b8b5a8]" style={mono}>
        Restoring is open to anyone. The connected wallet pays a small network fee, and ownership of
        the handle does not change.
      </p>

      <button
        type="button"
        onClick={handleRestore}
        disabled={busy || phase === 'restored'}
        className="inline-flex items-center justify-center border border-[#3a352a] bg-[#1a1815] px-4 py-2 text-[12px] font-medium uppercase tracking-[0.18em] text-[#f5f4ee] transition-colors hover:border-[var(--text-accent)] hover:text-[var(--text-accent)] disabled:cursor-not-allowed disabled:opacity-50"
        style={mono}
      >
        {phase === 'connecting'
          ? 'Connecting wallet…'
          : phase === 'restoring'
            ? 'Restoring binding…'
            : phase === 'polling'
              ? 'Confirming on-chain…'
              : phase === 'restored'
                ? 'Binding restored'
                : 'Restore binding'}
      </button>

      <div role="status" aria-live="polite" className="mt-3 space-y-1">
        {phase === 'restoring' && (
          <p className="text-[12px] text-[#8a8779]" style={mono}>
            Waiting for your wallet to sign the restore…
          </p>
        )}
        {phase === 'polling' && (
          <p className="text-[12px] text-[#8a8779]" style={mono}>
            Restore submitted. Waiting for the registry to confirm it…
          </p>
        )}
        {phase === 'restored' && (
          <p className="text-[12px] text-emerald-400" style={mono}>
            Binding restored. @{handle} resolves to its wallet again.
          </p>
        )}
        {phase === 'unconfirmed' && (
          <p className="text-[12px] text-amber-300" style={mono}>
            The restore was submitted, but the registry has not confirmed it yet. Check the
            transaction, then reload this page.
          </p>
        )}
        {phase === 'error' && errorMessage && (
          <p className="text-[12px] text-red-400" style={mono}>
            {errorMessage}
          </p>
        )}
        {txHash && phase !== 'error' && (
          <a
            href={stellarExpertTxUrl(txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-[11px] uppercase tracking-[0.18em] text-[var(--text-accent)] transition-colors hover:underline"
            style={mono}
          >
            View transaction on Stellar Expert ↗
          </a>
        )}
      </div>
    </div>
  );
}
