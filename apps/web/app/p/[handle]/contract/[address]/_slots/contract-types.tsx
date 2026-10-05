import { SlotPlaceholder } from './slot-placeholder';
import type { ContractSlotProps } from './slot-props';

/** Types slot (#450), for types and errors. #467 and #468 replace this body. */
export function ContractTypes(props: ContractSlotProps) {
  return <SlotPlaceholder slot="types" props={props} />;
}
