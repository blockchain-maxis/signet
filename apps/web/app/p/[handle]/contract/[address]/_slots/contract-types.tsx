import type { SpecJson } from '@signet/spec';
import { ErrorList } from '../_docs';
import { DocsState } from '../_docs/docs-state';
import { SpecWarnings } from '../_docs/spec-warnings';
import { SlotPlaceholder } from './slot-placeholder';
import type { ContractSlotProps } from './slot-props';

/**
 * Types slot (#450), for types and errors. #467 replaces the placeholder
 * with the type reference; #468's Errors section mounts below it. Keep the
 * two as separate siblings so neither change touches the other's markup. A
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
  return (
    <>
      <SlotPlaceholder slot="types" props={props} />
      {/* The loader's spec is a full `SpecJson`; `SpecInput` types only the slice the Overview reads. */}
      <ErrorList
        spec={props.spec.spec as SpecJson}
        handle={props.handle}
        address={props.address}
        className="mt-12"
      />
      <SpecWarnings warnings={props.spec.spec.warnings} />
    </>
  );
}
