import React from 'react';
import { docRefsFromSpec } from '@/lib/contract-docs';
import {
  buildEventReference,
  NO_EVENTS_NOTE,
  type EventReferenceSpec,
} from '@/lib/docs/event-reference';
import { typesTabHref, type LinkedPart } from '@/lib/docs/function-reference';
import { eventSearchText } from '@/lib/docs/search';
import { SectionLabel } from '../../../_components/section-label';
import { DocComment } from './doc-comment';
import { HeadingAnchor } from './heading-anchor';

export interface EventListProps {
  spec: EventReferenceSpec & Parameters<typeof docRefsFromSpec>[0];
  handle: string;
  address: string;
  className?: string;
}

const MONO = { fontFamily: 'var(--font-mono)' } as const;
const DISPLAY = { fontFamily: 'var(--font-display)' } as const;

const TYPE_LINK =
  'text-[#e05a4b] underline underline-offset-2 hover:decoration-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908]';

const TH = 'px-4 py-2.5 text-[10px] font-normal uppercase tracking-[0.22em] text-[#8a8779]';
const TABLE = 'mt-5 w-full max-w-[720px] border border-[#1f1d19] text-left [overflow-wrap:anywhere]';
const ROW = 'border-b border-[#1f1d19] align-top last:border-b-0';

function Parts({ parts }: { parts: readonly LinkedPart[] }) {
  return (
    <>
      {parts.map((part, i) =>
        part.href ? (
          <a key={i} href={part.href} className={TYPE_LINK}>
            {part.text}
          </a>
        ) : (
          <React.Fragment key={i}>{part.text}</React.Fragment>
        ),
      )}
    </>
  );
}

/**
 * The Types tab's Events section: declared `#[contractevent]` definitions
 * with their doc comment, prefix topics, parameters (type + topic/data
 * location), and payload data format.
 */
export function EventList({ spec, handle, address, className }: EventListProps) {
  const typesHref = typesTabHref(handle, address);
  const reference = buildEventReference(spec, typesHref);
  const refs = docRefsFromSpec(spec, typesHref);

  return (
    <section aria-label="Events" data-testid="event-list" className={className}>
      <SectionLabel as="h2">Events</SectionLabel>
      {reference.isEmpty ? (
        <p
          className="mt-4 max-w-[65ch] text-[13px] leading-[1.7] text-[#b8b5a8]"
          style={MONO}
          data-testid="no-events-note"
        >
          {reference.note ?? NO_EVENTS_NOTE}
        </p>
      ) : (
        <div className="mt-6">
          {reference.events.map((ev) => (
            <section
              key={ev.id}
              id={ev.id}
              aria-labelledby={`${ev.id}-name`}
              data-testid="event-section"
              data-search-text={eventSearchText(ev)}
              tabIndex={-1}
              className="scroll-mt-24 focus:outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-8 focus-visible:outline-[#8a8779] border-t border-[#1f1d19] py-8 first:border-t-0 first:pt-0"
            >
              <h3
                id={`${ev.id}-name`}
                data-anchor={ev.id}
                className="group flex flex-wrap items-baseline gap-x-3 text-[20px] font-bold tracking-[-0.015em] text-[#f5f4ee] [overflow-wrap:anywhere]"
                style={DISPLAY}
              >
                <span>{ev.name}</span>
                <HeadingAnchor id={ev.id} title={ev.name} />
              </h3>

              {ev.doc && (
                <div className="mt-4 max-w-[65ch] space-y-3">
                  <DocComment
                    doc={ev.doc}
                    refs={refs}
                    pClassName="text-[14px] leading-[1.7] text-[#b8b5a8]"
                  />
                </div>
              )}

              <dl
                className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-[12px] text-[#b8b5a8]"
                style={MONO}
              >
                {ev.prefixTopics.length > 0 && (
                  <div className="flex items-baseline gap-2">
                    <dt className="text-[10px] uppercase tracking-[0.2em] text-[#8a8779]">
                      Prefix topics
                    </dt>
                    <dd className="text-[#f5f4ee]">{ev.prefixTopics.join(', ')}</dd>
                  </div>
                )}
                <div className="flex items-baseline gap-2">
                  <dt className="text-[10px] uppercase tracking-[0.2em] text-[#8a8779]">
                    Data format
                  </dt>
                  <dd className="text-[#f5f4ee]">{ev.dataFormat}</dd>
                </div>
              </dl>

              {ev.params.length > 0 && (
                <table className={TABLE}>
                  <caption className="sr-only">Parameters of {ev.name}</caption>
                  <thead>
                    <tr className="border-b border-[#1f1d19]">
                      <th scope="col" className={TH} style={MONO}>
                        Name
                      </th>
                      <th scope="col" className={TH} style={MONO}>
                        Type
                      </th>
                      <th scope="col" className={TH} style={MONO}>
                        Location
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {ev.params.map((param) => (
                      <tr key={param.name} className={ROW}>
                        <th
                          scope="row"
                          className="px-4 py-2.5 text-[13px] font-normal text-[#f5f4ee]"
                          style={MONO}
                        >
                          {param.name}
                        </th>
                        <td className="px-4 py-2.5 text-[13px] text-[#b8b5a8]" style={MONO}>
                          <Parts parts={param.type} />
                        </td>
                        <td className="px-4 py-2.5 text-[13px] text-[#b8b5a8]" style={MONO}>
                          {param.location}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
