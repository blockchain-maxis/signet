'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

interface CopyAddressProps {
  address: string;
  display: string;
}

export function CopyAddress({ address, display }: CopyAddressProps) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Navigating away inside the 2s confirmation window would otherwise leave a
  // timer that sets state on an unmounted component.
  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  const confirm = useCallback(() => {
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 2000);
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(address);
      confirm();
    } catch {
      // Fallback for environments without clipboard API
      const el = document.createElement('textarea');
      el.value = address;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      confirm();
    }
  }, [address, confirm]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={address}
      aria-label={copied ? 'Address copied' : `Copy wallet address ${address}`}
      className="group flex items-center gap-2 text-left"
    >
      <span
        className="text-[13px] text-[#b8b5a8]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {display}
      </span>
      <span
        aria-hidden="true"
        className={`flex h-5 w-5 items-center justify-center rounded transition-colors ${
          copied
            ? 'text-[#4ade80]'
            : 'text-[#4a4740] group-hover:text-[#b8b5a8]'
        }`}
      >
        {copied ? (
          // Checkmark
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          // Copy icon (two overlapping squares)
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <rect x="4" y="4" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <path d="M4 3V2a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        )}
      </span>
      {/*
        Rendered unconditionally: a live region that mounts at the same moment
        as its text is frequently missed by screen readers. Only the text
        changes, which is the announcement.
      */}
      <span
        role="status"
        aria-live="polite"
        className="text-[11px] text-[#4ade80]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {copied ? 'copied' : ''}
      </span>
    </button>
  );
}
