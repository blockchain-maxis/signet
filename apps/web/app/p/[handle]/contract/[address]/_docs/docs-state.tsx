import type { SpecFailure } from '@/lib/contract-overview';
import { renderDocsState, type DocsSlot } from '@/lib/docs-state';
import { SectionLabel } from '../../../_components/section-label';

const TITLES: Record<DocsSlot, string> = { functions: 'Functions', types: 'Types' };

/**
 * The docs region when the interface cannot be shown (#470, design §1.5): one
 * distinct state per failure kind, under the tab's own h2. The shell around it
 * is unchanged.
 */
export function DocsState({
  slot,
  failure,
  network,
  address,
}: {
  slot: DocsSlot;
  failure: SpecFailure;
  network: string;
  address: string;
}) {
  return renderDocsState({ slot, failure, network, address }, (s) => (
    <SectionLabel as="h2">{TITLES[s]}</SectionLabel>
  ));
}
