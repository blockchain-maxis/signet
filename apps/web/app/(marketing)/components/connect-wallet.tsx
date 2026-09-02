'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { HANDLE_MAX_LEN, isReservedHandle, isValidHandle } from '@signet/types';
import { connectWallet, disconnectWallet, getConnectedAddress } from '@/lib/wallet';
import { claimHandle, isRegistryConfigured, RegistryNotConfiguredError } from '@/lib/registry';
import { STELLAR_NETWORK } from '@/lib/network';

function truncate(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : addr;
}

function validateHandle(handle: string): string | null {
  if (!handle) return 'Handle is required';
  if (!isValidHandle(handle)) {
    if (handle.length > HANDLE_MAX_LEN) {
      return `Handle must be ${HANDLE_MAX_LEN} characters or less`;
    }
    return 'Handle can only contain lowercase letters, numbers, underscores, and hyphens';
  }
  // Caught here rather than on-chain: `claim` rejects reserved names with
  // HandleReserved, so submitting would cost a fee to learn the same thing.
  if (isReservedHandle(handle)) return 'That handle is reserved for a Signet route';
  return null;
}

type Variant = 'nav' | 'cta';

/**
 * Wallet connect + handle claim entry point. Replaces the old dead `#` links.
 * Connecting proves wallet ownership; claiming writes the binding on-chain via
 * the Identity Registry (when configured).
 */
export function ConnectWallet({
  variant = 'nav',
  className = '',
}: {
  variant?: Variant;
  className?: string;
}) {
  const router = useRouter();
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [showClaimForm, setShowClaimForm] = useState(false);
  const [handle, setHandle] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    getConnectedAddress()
      .then(setAddress)
      .catch(() => {});
  }, []);

  async function onConnect() {
    setBusy(true);
    setStatus(null);
    try {
      setAddress(await connectWallet());
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setBusy(false);
    }
  }

  function onClaimClick() {
    if (!address) return onConnect();
    setShowClaimForm(true);
    setStatus(null);
    setValidationError(null);
  }

  function handleInputChange(value: string) {
    setHandle(value);
    const error = validateHandle(value);
    setValidationError(error);
  }

  async function onSubmitClaim() {
    if (!address || !handle) return;

    const error = validateHandle(handle);
    if (error) {
      setValidationError(error);
      return;
    }

    setBusy(true);
    setStatus(null);
    try {
      const { hash } = await claimHandle(handle, address);
      setStatus(`Claimed! tx ${truncate(hash)}`);
      setShowClaimForm(false);
      // Navigate to the public profile page on success
      setTimeout(() => {
        router.push(`/p/${handle}`);
      }, 1500);
    } catch (err) {
      if (err instanceof RegistryNotConfiguredError) {
        setStatus(
          'On-chain claim is unavailable — this deployment is not configured against an Identity Registry contract.',
        );
      } else {
        setStatus(err instanceof Error ? err.message : 'Claim failed');
      }
    } finally {
      setBusy(false);
    }
  }

  function onCancelClaim() {
    setShowClaimForm(false);
    setHandle('');
    setValidationError(null);
    setStatus(null);
  }

  async function onDisconnect() {
    await disconnectWallet();
    setAddress(null);
    setStatus(null);
    setShowClaimForm(false);
    setHandle('');
    setValidationError(null);
  }

  const label = busy
    ? '…'
    : address
      ? variant === 'cta'
        ? 'Claim your handle'
        : truncate(address)
      : 'Connect wallet';

  const actionLabel = busy
    ? `${variant === 'cta' ? 'Claiming handle' : 'Connecting wallet'}…`
    : address
      ? variant === 'cta'
        ? 'Claim your handle'
        : `Disconnect ${address}`
      : 'Connect wallet';

  // Show claim form
  if (showClaimForm && address) {
    return (
      <span className="inline-flex flex-col items-start gap-2">
        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={handle}
            onChange={(e) => handleInputChange(e.target.value)}
            placeholder="your-handle"
            disabled={busy}
            className="rounded border border-[#8b1a1a] bg-[#f5f4ee] px-3 py-2 text-sm font-mono text-[#1a1816] placeholder:text-[#8a8779] focus:outline-none focus:ring-2 focus:ring-[#8b1a1a] disabled:opacity-50"
            maxLength={HANDLE_MAX_LEN}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !validationError && handle) {
                onSubmitClaim();
              } else if (e.key === 'Escape') {
                onCancelClaim();
              }
            }}
          />
          {validationError && (
            <span className="text-xs text-[#8b1a1a]" style={{ fontFamily: 'var(--font-mono)' }}>
              {validationError}
            </span>
          )}
          <span
            className="max-w-[260px] text-[10px] leading-tight text-[#8a8779]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            The registry contract is immutable. If it is ever replaced, handles are re-claimed on
            the new one — held for your wallet, one signature.
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onSubmitClaim}
              disabled={busy || !handle || !!validationError}
              className="rounded bg-[#8b1a1a] px-4 py-2 text-sm text-[#f5f4ee] hover:bg-[#6d1515] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? 'Claiming…' : 'Claim'}
            </button>
            <button
              type="button"
              onClick={onCancelClaim}
              disabled={busy}
              className="rounded border border-[#8b1a1a] px-4 py-2 text-sm text-[#8b1a1a] hover:bg-[#8b1a1a] hover:text-[#f5f4ee] disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
        {status && (
          <span
            role="status"
            aria-live="polite"
            className="max-w-[260px] text-[10px] leading-tight text-[#8a8779]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {status}
          </span>
        )}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={variant === 'cta' ? onClaimClick : address ? onDisconnect : onConnect}
        disabled={busy}
        className={`${className} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b1a1a] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908]`}
        aria-label={actionLabel}
        aria-busy={busy}
      >
        {variant === 'cta' ? (
          <span className="inline-flex items-center gap-3">
            {label}
            <span className="text-[#8b1a1a] transition-transform duration-300 group-hover:translate-x-1 group-hover:text-[#f5f4ee]">
              →
            </span>
          </span>
        ) : (
          <>
            <span className="border-b border-[#8b1a1a] pb-1">{label}</span>
            <span className="ml-1.5 text-[#8b1a1a]">→</span>
          </>
        )}
      </button>
      {status && (
        <span
          role="status"
          aria-live="polite"
          className="max-w-[260px] text-[10px] leading-tight text-[#8a8779]"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {status}
        </span>
      )}
      {!isRegistryConfigured() && variant === 'nav' && address && (
        <span className="text-[9px] text-[#5e5b51]" style={{ fontFamily: 'var(--font-mono)' }}>
          connected · {STELLAR_NETWORK}
        </span>
      )}
    </span>
  );
}
