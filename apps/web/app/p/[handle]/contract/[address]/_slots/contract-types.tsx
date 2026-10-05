import { DocsState } from '../_docs/docs-state';
import { SpecWarnings } from '../_docs/spec-warnings';
import { SlotPlaceholder } from './slot-placeholder';
import type { ContractSlotProps } from './slot-props';

/**
 * Types slot (#450), for types and errors. #467 and #468 replace the
 * placeholder. A failure renders its own state (#470); warnings sit below.
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
  return (
    <>
      <SlotPlaceholder slot="types" props={props} />
      <SpecWarnings warnings={props.spec.spec.warnings} />
    </>
  );
}
