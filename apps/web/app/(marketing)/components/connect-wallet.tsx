'use client';

import { useEffect, useState } from 'react';
import { connectWallet, disconnectWallet, getConnectedAddress } from '@/lib/wallet';
import { claimHandle, isRegistryConfigured, RegistryNotConfiguredError } from '@/lib/registry';

function truncate(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : addr;
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
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    getConnectedAddress().then(setAddress).catch(() => {});
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

  async function onClaim() {
    if (!address) return onConnect();
    const handle = window.prompt('Choose your Signet handle (a–z, 0–9, _ or -):')?.trim();
    if (!handle) return;
    setBusy(true);
    setStatus(null);
    try {
      const { hash } = await claimHandle(handle, address);
      setStatus(`Claimed! tx ${truncate(hash)}`);
    } catch (err) {
      if (err instanceof RegistryNotConfiguredError) {
        setStatus('On-chain claim launches in Phase 2 — registry not yet deployed.');
      } else {
        setStatus(err instanceof Error ? err.message : 'Claim failed');
      }
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect() {
    await disconnectWallet();
    setAddress(null);
    setStatus(null);
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

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={variant === 'cta' ? onClaim : address ? onDisconnect : onConnect}
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
          connected · testnet
        </span>
      )}
    </span>
  );
}
