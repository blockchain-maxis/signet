import { SlotPlaceholder } from './slot-placeholder';
import type { ContractSlotProps } from './slot-props';

/**
 * Diagram slot (#450). #498 replaces this body. Design §2.4: when the diagram
 * cannot render it says why and links to Functions; it never shows an empty frame.
 */
export function ContractDiagram(props: ContractSlotProps) {
  return <SlotPlaceholder slot="diagram" props={props} />;
}
