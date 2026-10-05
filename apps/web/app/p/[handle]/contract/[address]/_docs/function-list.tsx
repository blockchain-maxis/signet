import React from 'react';
import { docRefsFromSpec, hasAnyDocComments } from '@/lib/contract-docs';
import {
  CONSTRUCTOR_NOTE,
  buildFunctionReference,
  typesTabHref,
  type FunctionReferenceSpec,
  type FunctionSection,
  type LinkedPart,
} from '@/lib/docs/function-reference';
import { SectionLabel } from '../../../_components/section-label';
import { DocComment } from './doc-comment';
import { NoDocCommentsNote } from './no-doc-comments-note';

export interface FunctionListProps {
  spec: FunctionReferenceSpec;
  handle: string;
  address: string;
  className?: string;
}

const MONO = { fontFamily: 'var(--font-mono)' } as const;
const DISPLAY = { fontFamily: 'var(--font-display)' } as const;

const TYPE_LINK =
  'text-[#e05a4b] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908]';

/** Type or signature tokens; a named type the spec defines links to the Types tab. */
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

function CanFail({ section }: { section: FunctionSection }) {
  const canFail = section.canFail;
  if (!canFail) return null;
  return (
    <div className="mt-6" data-testid="can-fail-with">
      <p className="text-[10px] uppercase tracking-[0.22em] text-[#8a8779]" style={MONO}>
        Can fail with
      </p>
      {canFail.enums.map((errorEnum) => (
        <p
          key={errorEnum.name}
          className="mt-2 break-words text-[13px] leading-[1.7] text-[#b8b5a8]"
          style={MONO}
        >
          <span className="text-[#f5f4ee]">{errorEnum.name}</span>
          {': '}
          {errorEnum.cases.map((c) => `${c.name} = ${c.value}`).join(', ')}
        </p>
      ))}
      <p className="mt-2 max-w-[65ch] text-[12px] leading-[1.7] text-[#8a8779]" style={MONO}>
        {canFail.note}
      </p>
    </div>
  );
}

function FunctionBlock({
  section,
  refs,
}: {
  section: FunctionSection;
  refs: ReturnType<typeof docRefsFromSpec>;
}) {
  return (
    <section
      id={section.id}
      aria-labelledby={`${section.id}-name`}
      data-testid="function-section"
      className="scroll-mt-24 border-t border-[#1f1d19] py-8 first:border-t-0 first:pt-0"
    >
      <h3
        id={`${section.id}-name`}
        className="text-[20px] font-bold tracking-[-0.015em] text-[#f5f4ee]"
        style={DISPLAY}
      >
        {section.name}
      </h3>
      <p
        className="mt-3 break-words text-[13px] leading-[1.7] text-[#f5f4ee]"
        style={MONO}
        data-testid="function-signature"
      >
        <code>
          <Parts parts={section.signature} />
        </code>
      </p>

      {section.doc && (
        <div className="mt-4 max-w-[65ch] space-y-3">
          <DocComment
            doc={section.doc}
            refs={refs}
            pClassName="text-[14px] leading-[1.7] text-[#b8b5a8]"
          />
        </div>
      )}

      {section.args.length > 0 && (
        <table className="mt-5 w-full max-w-[640px] border border-[#1f1d19] text-left">
          <caption className="sr-only">Arguments of {section.name}</caption>
          <thead>
            <tr className="border-b border-[#1f1d19]">
              <th
                scope="col"
                className="px-4 py-2.5 text-[10px] font-normal uppercase tracking-[0.22em] text-[#8a8779]"
                style={MONO}
              >
                Name
              </th>
              <th
                scope="col"
                className="px-4 py-2.5 text-[10px] font-normal uppercase tracking-[0.22em] text-[#8a8779]"
                style={MONO}
              >
                Type
              </th>
            </tr>
          </thead>
          <tbody>
            {section.args.map((arg) => (
              <tr key={arg.name} className="border-b border-[#1f1d19] last:border-b-0">
                <th
                  scope="row"
                  className="px-4 py-2.5 text-[13px] font-normal text-[#f5f4ee]"
                  style={MONO}
                >
                  {arg.name}
                </th>
                <td className="px-4 py-2.5 text-[13px] text-[#b8b5a8]" style={MONO}>
                  <Parts parts={arg.type} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CanFail section={section} />
    </section>
  );
}

/**
 * The Functions tab's reference (#466, design §2.3): one `<section>` per
 * function in declaration order, each with its signature, doc comment,
 * argument table and, when it can return an error, the "Can fail with" line.
 * The constructor gets its own subsection. An undocumented function still
 * renders in full; nothing stands in for a missing doc comment.
 *
 * The no-doc-comments note (#469) shows once, at the top, only when nothing in
 * the contract is documented.
 */
export function FunctionList({ spec, handle, address, className }: FunctionListProps) {
  const typesHref = typesTabHref(handle, address);
  const reference = buildFunctionReference(spec, typesHref);
  const refs = docRefsFromSpec(spec, typesHref);
  const showNoDocNote = !hasAnyDocComments(spec);

  return (
    <div className={className}>
      {showNoDocNote && (
        <div className="mb-8" data-slot="no-doc-comments-note">
          <NoDocCommentsNote />
        </div>
      )}

      {reference.ctor && (
        <div className="mb-10" data-testid="function-constructor">
          <SectionLabel>Constructor</SectionLabel>
          <p className="mb-6 mt-3 text-[12px] leading-[1.7] text-[#8a8779]" style={MONO}>
            {CONSTRUCTOR_NOTE}
          </p>
          <FunctionBlock section={reference.ctor} refs={refs} />
        </div>
      )}

      <div>
        {reference.ctor && reference.functions.length > 0 && (
          <div className="mb-6">
            <SectionLabel>Exported functions</SectionLabel>
          </div>
        )}
        {reference.functions.map((section) => (
          <FunctionBlock key={section.id} section={section} refs={refs} />
        ))}
      </div>
    </div>
  );
}
