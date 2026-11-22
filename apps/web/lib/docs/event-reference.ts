import type { SpecEvent, SpecEventDataFormat, SpecType } from '@signet/spec';
import { eventAnchor } from './anchors.ts';
import { linkedParts, type LinkedPart } from './function-reference.ts';

export const NO_EVENTS_NOTE = 'This contract declares no events in its interface.';

const DATA_FORMAT_LABELS: Readonly<Record<SpecEventDataFormat, string>> = {
  single_value: 'single value',
  vec: 'vector',
  map: 'map',
};

export interface EventReferenceSpec {
  readonly events?: readonly SpecEvent[];
  readonly types: readonly Pick<SpecType, 'name'>[];
}

export interface EventParamRow {
  readonly name: string;
  readonly type: readonly LinkedPart[];
  readonly location: 'topic' | 'data';
}

export interface EventEntry {
  readonly name: string;
  readonly id: string;
  readonly doc: string | null;
  readonly prefixTopics: readonly string[];
  readonly params: readonly EventParamRow[];
  readonly dataFormat: string;
}

export interface EventReference {
  readonly events: readonly EventEntry[];
  readonly isEmpty: boolean;
  readonly note: string | null;
}

function docOf(doc: string | undefined): string | null {
  return typeof doc === 'string' && doc.trim().length > 0 ? doc : null;
}

/** Build the Types tab's Events section data from a decoded contract spec. */
export function buildEventReference(spec: EventReferenceSpec, typesHref: string): EventReference {
  const rawEvents = spec.events ?? [];
  if (rawEvents.length === 0) {
    return { events: [], isEmpty: true, note: NO_EVENTS_NOTE };
  }

  const definedTypes = new Set(spec.types.map((t) => t.name));
  const events: EventEntry[] = rawEvents.map((ev) => ({
    name: ev.name,
    id: eventAnchor(ev.name),
    doc: docOf(ev.doc),
    prefixTopics: ev.prefixTopics,
    params: ev.params.map((p) => ({
      name: p.name,
      type: linkedParts(p.type, definedTypes, typesHref),
      location: p.location,
    })),
    dataFormat: DATA_FORMAT_LABELS[ev.dataFormat],
  }));

  return { events, isEmpty: false, note: null };
}
