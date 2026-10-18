import { SlotPlaceholder } from './slot-placeholder';
import type { ContractSlotProps } from './slot-props';

/**
 * Diagram slot (#450). #498 replaces this body. Design §2.4: when the diagram
 * cannot render it says why and links to Functions; it never shows an empty frame.
 * Bounded viewport container (#504): overflow: auto, max-height: 70vh, role="region".
 */
export function ContractDiagram(props: ContractSlotProps) {
  return (
    <div
      role="region"
      aria-label="Contract diagram viewport"
      tabIndex={0}
      className="viz-viewport max-h-[70vh] max-w-full overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-[#60a5fa]"
    >
      <SlotPlaceholder slot="diagram" props={props} />
    </div>
  );
}

