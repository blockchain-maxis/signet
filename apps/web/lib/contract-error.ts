/**
 * @file apps/web/lib/contract-error.ts
 *
 * What the contract route's error boundary shows (#459). The view is built here,
 * from host elements only, so a unit test can render it and press its button;
 * `contract/error.tsx` only reads the route params and hands them in.
 *
 * The boundary is for failures nothing else describes: attribution that could
 * not be decided (the layout throws), or an unexpected throw below it. A spec
 * that was reached but could not be read is content and renders inline under a
 * 200 (`DocsState`, #470), never here.
 *
 * Client-safe: no Node imports.
 */
import React from 'react';
import { isValidHandle } from '@signet/types';

const MONO = { fontFamily: 'var(--font-mono)' } as const;

/** Hover text is #f5f4ee over #2a1411: well above 4.5:1 (the old dark-red fill was not a safe choice). */
export const RETRY_BUTTON_CLASS =
  'mt-8 border border-[#e05a4b] px-6 py-3 text-[11px] uppercase tracking-[0.22em] transition-colors hover:bg-[#2a1411] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908]';

export interface ContractErrorModel {
  /** A handle the registry could contain, else `null`: the rest is whatever was typed in the URL. */
  handle: string | null;
  /** Matches the failure to the server log; the message itself is redacted on the client. */
  digest: string | null;
  networkName: string;
}

export function buildContractError(input: {
  handle?: unknown;
  digest?: string;
  networkName: string;
}): ContractErrorModel {
  return {
    handle: typeof input.handle === 'string' && isValidHandle(input.handle) ? input.handle : null,
    digest: input.digest ? input.digest : null,
    networkName: input.networkName,
  };
}

/** `retry` re-fetches and re-renders the segment, which is what a server-side failure needs. */
export function renderContractError(m: ContractErrorModel, retry: () => void): React.ReactElement {
  const h = React.createElement;
  return h(
    'main',
    {
      className:
        'flex min-h-screen flex-col items-center justify-center bg-[#0a0908] px-6 text-center text-[#f5f4ee]',
    },
    h(
      'div',
      { role: 'alert' },
      h(
        'p',
        { className: 'mb-3 text-[11px] uppercase tracking-[0.26em] text-[#e05a4b]', style: MONO },
        'Network unreachable',
      ),
      h(
        'h1',
        {
          className: 'text-4xl font-bold tracking-[-0.025em]',
          style: { fontFamily: 'var(--font-display)' },
        },
        `Couldn't reach ${m.networkName} right now`,
      ),
      h(
        'p',
        { className: 'mx-auto mt-4 max-w-sm text-sm text-[#8a8779]' },
        "Signet couldn't confirm this contract just now, so it shows nothing rather than something unverified. This is usually brief.",
      ),
    ),
    m.digest !== null &&
      h('p', { className: 'mt-3 text-[11px] text-[#8a8779]', style: MONO }, `ref ${m.digest}`),
    h(
      'button',
      { type: 'button', onClick: () => retry(), className: RETRY_BUTTON_CLASS, style: MONO },
      'Try again',
    ),
    m.handle !== null &&
      h(
        'a',
        {
          href: `/p/${m.handle}`,
          className:
            'mt-8 text-[11px] uppercase tracking-[0.22em] text-[#e05a4b] transition-colors hover:text-[#f0806f]',
          style: MONO,
        },
        `← Back to @${m.handle}`,
      ),
  );
}
