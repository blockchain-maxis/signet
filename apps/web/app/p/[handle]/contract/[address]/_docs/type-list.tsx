import React from 'react';
import { docRefsFromSpec } from '@/lib/contract-docs';
import { typesTabHref, type LinkedPart } from '@/lib/docs/function-reference';
import {
  NO_TYPES_NOTE,
  buildTypeReference,
  type TypeEntry,
  type TypeMemberRow,
  type TypeReferenceSpec,
} from '@/lib/docs/type-reference';
import { DocComment } from './doc-comment';

export interface TypeListProps {
  spec: TypeReferenceSpec;
  handle: string;
  address: string;
  className?: string;
}

type Refs = ReturnType<typeof docRefsFromSpec>;

const MONO = { fontFamily: 'var(--font-mono)' } as const;
const DISPLAY = { fontFamily: 'var(--font-display)' } as const;

const TYPE_LINK =
  'text-[#e05a4b] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908]';

const TH = 'px-4 py-2.5 text-[10px] font-normal uppercase tracking-[0.22em] text-[#8a8779]';
const TABLE = 'mt-5 w-full max-w-[720px] border border-[#1f1d19] text-left';
const ROW = 'border-b border-[#1f1d19] align-top last:border-b-0';

/** Type tokens; a named type the spec defines links to its entry below or above. */
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

function Doc({ doc, refs }: { doc: string | null; refs: Refs }) {
  if (!doc) return null;
  return (
    <div className="space-y-2">
      <DocComment doc={doc} refs={refs} pClassName="text-[13px] leading-[1.7] text-[#b8b5a8]" />
    </div>
  );
}

function Head({ labels }: { labels: readonly string[] }) {
  return (
    <thead>
      <tr className="border-b border-[#1f1d19]">
        {labels.map((label) => (
          <th key={label} scope="col" className={TH} style={MONO}>
            {label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function RowName({ children }: { children: React.ReactNode }) {
  return (
    <th scope="row" className="px-4 py-2.5 text-[13px] font-normal text-[#f5f4ee]" style={MONO}>
      {children}
    </th>
  );
}

function Cell({ children }: { children?: React.ReactNode }) {
  return (
    <td className="px-4 py-2.5 text-[13px] text-[#b8b5a8]" style={MONO}>
      {children}
    </td>
  );
}

/** A Description column only when some row has a doc comment: no empty column of blanks. */
function anyDoc(rows: readonly { doc: string | null }[]): boolean {
  return rows.some((row) => row.doc !== null);
}

function Payload({ members }: { members: readonly TypeMemberRow[] }) {
  if (members.length === 0) return <span className="text-[#8a8779]">no payload</span>;
  return (
    <>
      {members.map((m, i) => (
        <React.Fragment key={`${m.name}-${i}`}>
          {i > 0 && ', '}
          <Parts parts={m.type} />
        </React.Fragment>
      ))}
    </>
  );
}

function Members({ entry, refs }: { entry: TypeEntry; refs: Refs }) {
  if (entry.kind === 'struct') {
    if (entry.fields.length === 0) return null;
    const docs = anyDoc(entry.fields);
    return (
      <table className={TABLE}>
        <caption className="sr-only">Fields of {entry.name}</caption>
        <Head labels={docs ? ['Name', 'Type', 'Description'] : ['Name', 'Type']} />
        <tbody>
          {entry.fields.map((field) => (
            <tr key={field.name} className={ROW}>
              <RowName>{field.name}</RowName>
              <Cell>
                <Parts parts={field.type} />
              </Cell>
              {docs && (
                <Cell>
                  <Doc doc={field.doc} refs={refs} />
                </Cell>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (entry.kind === 'union') {
    if (entry.cases.length === 0) return null;
    const docs = anyDoc(entry.cases);
    return (
      <table className={TABLE}>
        <caption className="sr-only">Cases of {entry.name}</caption>
        <Head labels={docs ? ['Case', 'Payload', 'Description'] : ['Case', 'Payload']} />
        <tbody>
          {entry.cases.map((c) => (
            <tr key={c.name} className={ROW}>
              <RowName>{c.name}</RowName>
              <Cell>
                <Payload members={c.payload} />
              </Cell>
              {docs && (
                <Cell>
                  <Doc doc={c.doc} refs={refs} />
                </Cell>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (entry.variants.length === 0) return null;
  const docs = anyDoc(entry.variants);
  return (
    <table className={TABLE}>
      <caption className="sr-only">Variants of {entry.name}</caption>
      <Head labels={docs ? ['Variant', 'Value', 'Description'] : ['Variant', 'Value']} />
      <tbody>
        {entry.variants.map((v) => (
          <tr key={v.name} className={ROW}>
            <RowName>{v.name}</RowName>
            <Cell>{v.value}</Cell>
            {docs && (
              <Cell>
                <Doc doc={v.doc} refs={refs} />
              </Cell>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const KIND_LABEL = { struct: 'struct', union: 'union', enum: 'enum' } as const;

function TypeBlock({ entry, refs }: { entry: TypeEntry; refs: Refs }) {
  return (
    <section
      id={entry.id}
      aria-labelledby={`${entry.id}-name`}
      data-testid="type-section"
      className="scroll-mt-24 border-t border-[#1f1d19] py-8 first:border-t-0 first:pt-0"
    >
      <h3
        id={`${entry.id}-name`}
        className="flex flex-wrap items-baseline gap-x-3 text-[20px] font-bold tracking-[-0.015em] text-[#f5f4ee]"
        style={DISPLAY}
      >
        {entry.name}
        <span
          className="text-[11px] font-normal tracking-[0.12em] text-[#8a8779]"
          style={MONO}
        >
          {KIND_LABEL[entry.kind]}
        </span>
      </h3>
      {entry.doc && (
        <div className="mt-4 max-w-[65ch] space-y-3">
          <DocComment
            doc={entry.doc}
            refs={refs}
            pClassName="text-[14px] leading-[1.7] text-[#b8b5a8]"
          />
        </div>
      )}
      <Members entry={entry} refs={refs} />
    </section>
  );
}

/**
 * The Types tab's reference (#467, design §2.3): one `<section id="type-…">`
 * per type a function can reach, alphabetical, with its fields, cases or
 * variants. Nested named types are links, one level inline and linked beyond.
 * Types no function reaches sit in a collapsed `<details>` with a count; a
 * signature naming a type the spec lacks gets one plain sentence.
 *
 * A contract with no types of its own gets one line, not an empty list.
 */
export function TypeList({ spec, handle, address, className }: TypeListProps) {
  const typesHref = typesTabHref(handle, address);
  const reference = buildTypeReference(spec, typesHref);
  const refs = docRefsFromSpec(spec, typesHref);

  if (reference.isEmpty) {
    return (
      <p
        className={`text-[13px] leading-[1.7] text-[#b8b5a8] ${className ?? ''}`}
        style={MONO}
        data-testid="no-types-note"
      >
        {NO_TYPES_NOTE}
      </p>
    );
  }

  return (
    <div className={className}>
      {reference.missing.length > 0 && (
        <ul className="mb-8 space-y-2" data-testid="missing-types">
          {reference.missing.map((m) => (
            <li
              key={m.name}
              className="max-w-[65ch] text-[13px] leading-[1.7] text-[#b8b5a8]"
              style={MONO}
            >
              {m.before}
              <code className="text-[#f5f4ee]">{m.name}</code>
              {m.after}
            </li>
          ))}
        </ul>
      )}

      {reference.used.length > 0 && (
        <div data-testid="used-types">
          {reference.used.map((entry) => (
            <TypeBlock key={entry.id} entry={entry} refs={refs} />
          ))}
        </div>
      )}

      {reference.unusedLabel && (
        <details
          className="mt-8 border-t border-[#1f1d19] pt-6 first:mt-0 first:border-t-0 first:pt-0"
          data-testid="unused-types"
        >
          <summary
            className="cursor-pointer text-[13px] text-[#b8b5a8] hover:text-[#f5f4ee] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908]"
            style={MONO}
          >
            {reference.unusedLabel}
          </summary>
          <div className="mt-6">
            {reference.unused.map((entry) => (
              <TypeBlock key={entry.id} entry={entry} refs={refs} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
