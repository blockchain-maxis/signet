'use client';

import { useState } from 'react';

export interface StorageToggleProps {
  /** The id of the server-rendered storage view this shows and hides. */
  controls: string;
  initiallyOn: boolean;
  /** Why there is nothing to show; the toggle is then disabled, with this as its description. */
  disabledReason?: string;
}

/**
 * The storage view's toggle (#515). The view is rendered on the server;
 * this only shows or hides it, so focus stays on the toggle, and keeps
 * `?storage=` in the URL so the state is a permalink.
 */
export function StorageToggle({ controls, initiallyOn, disabledReason }: StorageToggleProps) {
  const [on, setOn] = useState(initiallyOn && !disabledReason);
  const reasonId = `${controls}-reason`;

  const toggle = () => {
    if (disabledReason) return;
    const next = !on;
    setOn(next);
    const panel = document.getElementById(controls);
    if (panel) panel.hidden = !next;
    const url = new URL(window.location.href);
    url.searchParams.set('storage', next ? '1' : '0');
    window.history.replaceState(window.history.state, '', url);
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={toggle}
        aria-pressed={on}
        aria-controls={controls}
        aria-disabled={disabledReason ? true : undefined}
        aria-describedby={disabledReason ? reasonId : undefined}
        data-testid="storage-toggle"
        className={`rounded border px-3 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b] ${
          disabledReason
            ? 'cursor-not-allowed border-[#2b2721] text-[#8a8779]'
            : on
              ? 'border-[#e05a4b] text-[#f5f4ee]'
              : 'border-[#2b2721] text-[#f5f4ee] hover:border-[#e05a4b]'
        }`}
      >
        Storage view
      </button>
      {disabledReason && (
        <span id={reasonId} className="text-xs text-[#8a8779]">
          {disabledReason}
        </span>
      )}
    </div>
  );
}
