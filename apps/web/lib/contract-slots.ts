/**
 * What an unbuilt tab slot says (#450).
 *
 * Functions, Types and Diagram are rendered by later epics. Until each lands,
 * its slot shows the copy here: that the view is not built yet, and where to
 * go instead. Nothing is invented to fill the space; there is no example
 * content. Pure, so the wording and the links are testable without a render.
 *
 * The Diagram follows design §2.4: when the interface cannot be shown the tab
 * says why and links to Functions, and never draws an empty frame.
 */
import { failureCopy, type SpecInput } from './contract-overview.ts';

export type SlotName = 'functions' | 'types' | 'diagram';

/** Where a placeholder sends the reader. */
export type SlotTarget = 'overview' | 'functions';

export interface SlotPlaceholder {
  /** The §1.5 failure headline when the interface could not be shown, else `null`. */
  readonly reason: string | null;
  /** One sentence of body copy. */
  readonly message: string;
  readonly link: { readonly label: string; readonly target: SlotTarget };
}

const NOT_BUILT: Record<SlotName, string> = {
  functions: 'The Functions view is not built yet.',
  types: 'The Types view is not built yet.',
  diagram: 'The Diagram view is not built yet.',
};

export function slotPlaceholder(slot: SlotName, input: SpecInput): SlotPlaceholder {
  if (slot === 'diagram' && input.kind === 'failure') {
    return {
      reason: failureCopy(input.failure).title,
      message:
        'The diagram can’t be drawn without a readable interface. The Functions tab says what is known.',
      link: { label: 'Open Functions', target: 'functions' },
    };
  }
  return {
    reason: null,
    message: NOT_BUILT[slot],
    link: { label: 'Back to the Overview', target: 'overview' },
  };
}
