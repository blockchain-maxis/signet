'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

/**
 * Copy a permalink to the clipboard.
 *
 * The permalink is the point of this page: someone who lands here wants to send
 * the exact URL for one function, not the contract. The button takes the path
 * and resolves it against the current origin on click, so the server-rendered
 * HTML holds no origin and the same markup is correct on any deployment.
 */
export function CopyLink({ href, label }: { href: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Navigating away inside the confirmation window would otherwise leave a
  // timer that sets state on an unmounted component.
  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    const url = new URL(href, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Fallback for environments without the clipboard API.
      const el = document.createElement('textarea');
      el.value = url;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 2000);
  }, [href]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-[#8b1a1a] transition-colors hover:text-[#c2410c]"
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      <span aria-hidden="true" className="flex h-4 w-4 items-center justify-center">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <rect x="4" y="4" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M4 3V2a1 1 0 0 0-1 1v6a1 1 0 1 0 1 1h1"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span>{copied ? 'Copied' : 'Copy link'}</span>
      {/*
        Rendered unconditionally: a live region that mounts at the same moment
        as its text is frequently missed by screen readers. Only the text
        changes, which is the announcement.
      */}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? `${label} link copied to clipboard` : ''}
      </span>
    </button>
  );
}
