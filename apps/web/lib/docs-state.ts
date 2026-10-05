/**
 * @file apps/web/lib/docs-state.ts
 *
 * What the Functions and Types tabs say when there is no interface to list
 * (#470, docs/CONTRACT_DOCS_DESIGN.md §1.5). One distinct display per failure
 * kind, none of them a generic error page: the shell (identity, address,
 * deploy tx) still renders and only the docs region changes.
 *
 * The wording reuses `failureCopy` (#449) so the Overview and the docs tabs
 * say the same thing. Only two states differ, because the tab has room for
 * more than the Overview's one line: a Stellar Asset Contract (the protocol
 * defines its interface) and the RPC being unreachable (names the network).
 *
 * Nothing here reads an error object. The copy is built from the typed fields
 * of a `SpecFailure` alone, so no stack trace or raw message can reach the page.
 */
import React from 'react';
import { failureCopy, type SpecFailure } from './contract-overview.ts';

export type DocsSlot = 'functions' | 'types';

/** SEP-41, the token interface a Stellar Asset Contract implements. */
export const SEP_41_URL =
  'https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md';

export interface DocsStateCopy {
  readonly kind: SpecFailure['kind'];
  /** `stellar_asset_contract` for the SAC variant of `no_interface`, else `null`. */
  readonly variant: 'stellar_asset_contract' | null;
  readonly heading: string;
  /** One factual sentence, or `null` when the heading says everything. */
  readonly body: string | null;
  /** Show the contract address: a wrong-network mistake is only obvious with it. */
  readonly showAddress: boolean;
  readonly link: { readonly label: string; readonly href: string } | null;
}

/**
 * The copy for one failure on a docs tab.
 *
 * @param failure - why the interface could not be shown.
 * @param network - the contract's network, named when the RPC is unreachable.
 */
export function docsStateCopy(failure: SpecFailure, network: string): DocsStateCopy {
  const base = failureCopy(failure);
  switch (failure.kind) {
    case 'contract_not_found':
      return {
        kind: failure.kind,
        variant: null,
        heading: base.title,
        body: base.detail,
        showAddress: true,
        link: null,
      };
    case 'no_interface':
      if (failure.reason === 'stellar_asset_contract') {
        return {
          kind: failure.kind,
          variant: 'stellar_asset_contract',
          heading: 'This is a Stellar Asset Contract',
          body: 'Its interface is defined by the protocol, not by deployed WASM.',
          showAddress: false,
          link: { label: 'Read the SEP-41 token interface', href: SEP_41_URL },
        };
      }
      return {
        kind: failure.kind,
        variant: null,
        heading: base.title,
        body: 'The deployed WASM has no interface section, so there are no functions or types to list.',
        showAddress: false,
        link: null,
      };
    case 'interface_unreadable':
      return {
        kind: failure.kind,
        variant: null,
        heading: base.title,
        body: base.detail,
        showAddress: false,
        link: null,
      };
    case 'unavailable':
      return {
        kind: failure.kind,
        variant: null,
        heading: `Couldn't reach ${network} RPC. Try again shortly.`,
        body: 'Nothing is known about this contract’s interface until the RPC answers.',
        showAddress: false,
        link: null,
      };
    case 'wrong_network':
      return {
        kind: failure.kind,
        variant: null,
        heading: base.title,
        body: base.detail,
        showAddress: false,
        link: null,
      };
  }
}

export interface DocsStateProps {
  slot: DocsSlot;
  failure: SpecFailure;
  network: string;
  address: string;
}

const LINK_FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908]';

/**
 * Pure element factory for a docs-tab failure state; `_docs/docs-state.tsx`
 * wraps it as a component. The section keeps the `slot-<name>` test id of the
 * placeholder it replaces, so tab specs address it the same way.
 *
 * @param sectionLabel - renders the tab's own h2 (kept out of lib: it is a component).
 */
export function renderDocsState(
  props: DocsStateProps,
  sectionLabel: (slot: DocsSlot) => React.ReactNode,
): React.ReactElement {
  const copy = docsStateCopy(props.failure, props.network);
  const h = React.createElement;
  return h(
    'section',
    { 'data-testid': `slot-${props.slot}` },
    sectionLabel(props.slot),
    h(
      'div',
      {
        className: 'mt-6 max-w-[65ch]',
        'data-testid': 'docs-state',
        'data-kind': copy.kind,
        'data-variant': copy.variant ?? undefined,
      },
      h(
        'h3',
        {
          className:
            'mb-3 text-[20px] font-bold tracking-[-0.015em] text-[#f5f4ee] [text-wrap:balance]',
          style: { fontFamily: 'var(--font-display)' },
          'data-testid': 'docs-state-heading',
        },
        copy.heading,
      ),
      copy.body
        ? h(
            'p',
            {
              className: 'text-[13px] leading-[1.7] text-[#b8b5a8]',
              style: { fontFamily: 'var(--font-mono)' },
            },
            copy.body,
          )
        : null,
      copy.showAddress
        ? h(
            'p',
            {
              className:
                'mt-4 break-all border-l border-[#1f1d19] pl-4 text-[12px] leading-[1.7] text-[#8a8779]',
              style: { fontFamily: 'var(--font-mono)' },
              'data-testid': 'docs-state-address',
            },
            props.address,
          )
        : null,
      copy.link
        ? h(
            'a',
            {
              href: copy.link.href,
              target: '_blank',
              rel: 'noopener noreferrer',
              className: `mt-4 inline-block text-[10px] uppercase tracking-[0.2em] text-[#e05a4b] transition-colors hover:text-[#f0806f] ${LINK_FOCUS}`,
              style: { fontFamily: 'var(--font-mono)' },
            },
            copy.link.label,
            h('span', { className: 'sr-only' }, ' (opens in a new tab)'),
          )
        : null,
    ),
  );
}

/**
 * The decoder's non-fatal notes (#432), trimmed and de-duplicated, blank ones
 * dropped. Empty means render nothing.
 */
export function specWarnings(spec: { readonly warnings?: readonly string[] }): string[] {
  const seen = new Set<string>();
  for (const w of spec.warnings ?? []) {
    const text = typeof w === 'string' ? w.trim() : '';
    if (text) seen.add(text);
  }
  return [...seen];
}

/** Small muted list shown under the provenance strip; `null` when there are none. */
export function renderSpecWarnings(warnings: readonly string[]): React.ReactElement | null {
  if (warnings.length === 0) return null;
  const h = React.createElement;
  return h(
    'ul',
    {
      className: 'mt-6 space-y-1 text-[11px] leading-[1.7] text-[#8a8779]',
      style: { fontFamily: 'var(--font-mono)' },
      'aria-label': 'Interface notes',
      'data-testid': 'spec-warnings',
    },
    warnings.map((w) => h('li', { key: w }, w)),
  );
}
