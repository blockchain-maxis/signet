import type { SpecJson } from '@signet/spec';
import { SectionLabel } from '../../../_components/section-label';
import { ErrorList, TypeList } from '../_docs';
import { DocsState } from '../_docs/docs-state';
import { SpecWarnings } from '../_docs/spec-warnings';
import type { ContractSlotProps } from './slot-props';

/**
 * Types slot (#450, #467, #468): the types a function can reach, then the
 * contract's errors as a sibling block below. The h2 is the tab's heading. A
 * failure renders its own state (#470); warnings sit below.
 */
export function ContractTypes(props: ContractSlotProps) {
  if (props.spec.kind === 'failure') {
    return (
      <DocsState
        slot="types"
        failure={props.spec.failure}
        network={props.network}
        address={props.address}
      />
    );
  }
  // The loader's spec is a full `SpecJson`; `SpecInput` types only the slice the Overview reads.
  const spec = props.spec.spec as SpecJson;
  return (
    <section data-testid="slot-types">
      <SectionLabel as="h2">Types</SectionLabel>
      <div className="mt-6">
        <TypeList spec={spec} handle={props.handle} address={props.address} />
      </div>
      <ErrorList spec={spec} handle={props.handle} address={props.address} className="mt-12" />
      <SpecWarnings warnings={props.spec.spec.warnings} />
    </section>
  );
}
