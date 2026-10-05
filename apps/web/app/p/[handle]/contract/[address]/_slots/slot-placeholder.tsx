import Link from 'next/link';
import { contractTabSegmentHref } from '@/lib/contract-tabs';
import { slotPlaceholder, type SlotName } from '@/lib/contract-slots';
import { SectionLabel } from '../../../_components/section-label';
import type { ContractSlotProps } from './slot-props';

const MONO = { fontFamily: 'var(--font-mono)' } as const;
const DISPLAY = { fontFamily: 'var(--font-display)' } as const;

const TITLES: Record<SlotName, string> = {
  functions: 'Functions',
  types: 'Types',
  diagram: 'Diagram',
};

/**
 * The honest state of a slot whose epic has not landed (#450). The h2 is the
 * tab's heading (the tab-focus and axe specs rely on it); the copy comes from
 * `slotPlaceholder`. Each epic replaces its slot component, not this file.
 */
export function SlotPlaceholder({ slot, props }: { slot: SlotName; props: ContractSlotProps }) {
  const placeholder = slotPlaceholder(slot, props.spec);
  const href =
    placeholder.link.target === 'functions'
      ? contractTabSegmentHref(props.handle, props.address, 'functions')
      : `/p/${props.handle}/contract/${props.address}`;

  return (
    <section data-testid={`slot-${slot}`}>
      <SectionLabel as="h2">{TITLES[slot]}</SectionLabel>
      <div className="mt-6 max-w-[65ch]">
        {placeholder.reason && (
          <p
            className="mb-3 text-[20px] font-bold tracking-[-0.015em] text-[#f5f4ee]"
            style={DISPLAY}
          >
            {placeholder.reason}
          </p>
        )}
        <p className="text-[13px] leading-[1.7] text-[#b8b5a8]" style={MONO}>
          {placeholder.message}
        </p>
        <Link
          href={href}
          className="mt-4 inline-block text-[10px] uppercase tracking-[0.2em] text-[#e05a4b] transition-colors hover:text-[#f0806f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908]"
          style={MONO}
        >
          {placeholder.link.label}
        </Link>
      </div>
    </section>
  );
}
