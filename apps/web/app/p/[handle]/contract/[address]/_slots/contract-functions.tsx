import type { SpecJson } from '@signet/spec';
import { SectionLabel } from '../../../_components/section-label';
import { FunctionList } from '../_docs';
import { DocsState } from '../_docs/docs-state';
import { SpecWarnings } from '../_docs/spec-warnings';
import type { ContractSlotProps } from './slot-props';

/**
 * Functions slot (#450, #466): the function reference. The h2 is the tab's
 * heading. When the interface could not be read, `DocsState` says why (#470,
 * §1.5) and shows no list; the decoder's warnings sit below the list.
 */
export function ContractFunctions({ handle, address, network, spec }: ContractSlotProps) {
  if (spec.kind === 'failure') {
    return <DocsState slot="functions" failure={spec.failure} network={network} address={address} />;
  }
  return (
    <section data-testid="slot-functions">
      <SectionLabel as="h2">Functions</SectionLabel>
      <div className="mt-6">
        {/* The loader's spec is a full `SpecJson`; `SpecInput` types only the slice the Overview reads. */}
        <FunctionList spec={spec.spec as SpecJson} handle={handle} address={address} />
      </div>
      <SpecWarnings warnings={spec.spec.warnings} />
    </section>
  );
}
