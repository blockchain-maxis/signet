import { SlotPlaceholder } from './slot-placeholder';
import type { ContractSlotProps } from './slot-props';

/** Functions slot (#450). #466 replaces this body with the function list. */
export function ContractFunctions(props: ContractSlotProps) {
  return <SlotPlaceholder slot="functions" props={props} />;
}
