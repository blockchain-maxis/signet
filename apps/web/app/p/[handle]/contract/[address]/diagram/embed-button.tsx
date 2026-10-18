'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

export function EmbedButton({ handle, address }: { handle: string; address: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState<'auto' | 'dark' | 'light'>('auto');
  const [origin, setOrigin] = useState('');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  const path = `/p/${encodeURIComponent(handle)}/contract/${encodeURIComponent(address)}/embed`;
  const queryString = theme !== 'auto' ? `?theme=${theme}` : '';
  const embedUrl = origin ? `${origin}${path}${queryString}` : `${path}${queryString}`;
  const iframeSnippet = `<iframe src="${embedUrl}" width="100%" height="600" frameborder="0" title="${handle} contract diagram"></iframe>`;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(iframeSnippet);
    } catch {
      const el = document.createElement('textarea');
      el.value = iframeSnippet;
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
  }, [iframeSnippet]);

  return (
    <div className="relative inline-block text-left">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className="inline-flex items-center gap-2 text-sm underline underline-offset-4 focus-visible:outline focus-visible:outline-2"
      >
        Embed
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label="Embed diagram code"
          className="absolute left-0 top-full z-40 mt-2 w-80 sm:w-96 rounded border border-[#1f1d19] bg-[#14120f] p-4 shadow-xl"
        >
          <div className="flex items-center justify-between pb-3 border-b border-[#1f1d19]">
            <h3
              className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#f5f4ee]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              Embed diagram
            </h3>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="text-[#8a8779] hover:text-[#f5f4ee] text-xs px-1"
              aria-label="Close embed dialog"
            >
              &times;
            </button>
          </div>

          <div className="mt-3">
            <div className="mb-2 flex items-center justify-between text-xs text-[#8a8779]">
              <span>Theme:</span>
              <div className="flex gap-2">
                {(['auto', 'dark', 'light'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTheme(t)}
                    className={`px-2 py-0.5 rounded text-[10px] uppercase font-mono ${
                      theme === t
                        ? 'bg-[#e05a4b] text-white'
                        : 'bg-[#1f1d19] text-[#8a8779] hover:text-[#f5f4ee]'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <pre className="mt-2 overflow-x-auto rounded border border-[#1f1d19] bg-[#0a0908] p-2.5 text-[11px] leading-relaxed text-[#b8b5a8] font-mono select-all whitespace-pre-wrap break-all">
              <code>{iframeSnippet}</code>
            </pre>

            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 rounded bg-[#e05a4b] px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] text-white transition-colors hover:bg-[#f0806f] focus-visible:outline focus-visible:outline-2"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                {copied ? 'Copied!' : 'Copy Code'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
