import type { SpecJson } from '@signet/spec';
import { failureCopy } from '@/lib/contract-overview';
import { SectionLabel } from '../../../_components/section-label';
import { FunctionList } from '../_docs';
import type { ContractSlotProps } from './slot-props';

const MONO = { fontFamily: 'var(--font-mono)' } as const;
const DISPLAY = { fontFamily: 'var(--font-display)' } as const;

/**
 * Functions slot (#450, #466): the function reference. The h2 is the tab's
 * heading. When the interface could not be read it says why with the §1.5
 * copy and shows no list; #470 owns the full failure states.
 */
export function ContractFunctions({ handle, address, spec }: ContractSlotProps) {
  const failure = spec.kind === 'failure' ? failureCopy(spec.failure) : null;
  return (
    <section data-testid="slot-functions">
      <SectionLabel as="h2">Functions</SectionLabel>
      <div className="mt-6">
        {spec.kind === 'spec' ? (
          // The loader's spec is a full `SpecJson`; `SpecInput` types only the slice the Overview reads.
          <FunctionList spec={spec.spec as SpecJson} handle={handle} address={address} />
        ) : (
          <div className="max-w-[65ch]">
            <p
              className="mb-3 text-[20px] font-bold tracking-[-0.015em] text-[#f5f4ee]"
              style={DISPLAY}
            >
              {failure?.title}
            </p>
            {failure?.detail && (
              <p className="text-[13px] leading-[1.7] text-[#b8b5a8]" style={MONO}>
                {failure.detail}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
