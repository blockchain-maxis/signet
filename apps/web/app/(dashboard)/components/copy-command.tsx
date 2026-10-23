'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const mono = { fontFamily: 'var(--font-mono)' } as const;

/**
 * A copy button for a shell command (#607).
 *
 * The button's name is "Copy command" (the visible label is just "Copy"), and
 * the confirmation is a live region that is always in the page: a region that
 * mounts at the same moment as its text is frequently missed by screen readers,
 * so only its text changes, and that change is the announcement.
 */
export function CopyCommand({ command }: { command: string }) {
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
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // Fallback for environments without the clipboard API.
      const el = document.createElement('textarea');
      el.value = command;
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
  }, [command]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-[var(--text-accent)] transition-colors hover:text-[var(--text-accent)]"
      style={mono}
    >
      <span aria-hidden="true">{copied ? 'Copied' : 'Copy'}</span>
      <span className="sr-only">Copy command</span>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? 'Command copied to clipboard' : ''}
      </span>
    </button>
  );
}
