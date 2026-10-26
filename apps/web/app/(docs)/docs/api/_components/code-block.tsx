'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const mono = { fontFamily: 'var(--font-mono)' } as const;

/**
 * A code sample with a copy button (#649). The button's accessible name says
 * what it copies ("Copy curl example"); the confirmation is a live region that
 * is always in the page, so only its text changes, as in CopyCommand.
 */
export function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const el = document.createElement('textarea');
      el.value = code;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }, [code]);

  return (
    <div className="relative mt-3 border border-[#1f1d19] bg-[#0e0d0b]">
      <div className="flex items-center justify-between border-b border-[#1f1d19] px-4 py-2">
        <span className="text-[10px] uppercase tracking-[0.2em] text-[#8a8779]" style={mono}>
          {label}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label}`}
          className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-accent)] transition-colors hover:text-[#f5f4ee] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--text-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e0d0b] active:translate-y-px"
          style={mono}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <span role="status" aria-live="polite" className="sr-only">
          {copied ? `${label} copied to clipboard` : ''}
        </span>
      </div>
      <pre
        className="overflow-x-auto px-4 py-3 text-[12px] leading-[1.7] text-[#b8b5a8]"
        style={mono}
        tabIndex={0}
        aria-label={label}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
