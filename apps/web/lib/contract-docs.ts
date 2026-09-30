/**
 * @file apps/web/lib/contract-docs.ts
 *
 * Plain-text doc comment processing and spec documentation utilities (#469, D-06).
 * Follows CONTRACT_DOCS_DESIGN.md §2.4:
 * - Doc comments render as plain text: paragraphs split on blank lines, single newlines preserved,
 *   no HTML interpretation (escaped literal text).
 * - When zero functions, types, and errors carry a doc comment, show the note:
 *   "This contract's build publishes no doc comments. The signatures below come from the deployed code."
 *   Partial documentation gets NO note.
 * - No empty paragraph elements (<p></p>) are rendered when doc comments are absent.
 */

import React from 'react';

/**
 * The single honest note displayed at the top of the Functions tab
 * when zero functions, types, and errors in the contract build carry doc comments.
 */
export const NO_DOC_COMMENTS_NOTE =
  "This contract's build publishes no doc comments. The signatures below come from the deployed code.";

export interface SpecFieldLike {
  readonly name?: string;
  readonly doc?: string;
  readonly type?: any;
}

export interface SpecFunctionLike {
  readonly name: string;
  readonly doc?: string;
  readonly inputs?: readonly SpecFieldLike[];
  readonly outputs?: readonly any[];
}

export interface SpecStructLike {
  readonly kind?: 'struct';
  readonly name: string;
  readonly doc?: string;
  readonly fields?: readonly SpecFieldLike[];
}

export interface SpecUnionCaseLike {
  readonly name: string;
  readonly doc?: string;
  readonly fields?: readonly SpecFieldLike[];
}

export interface SpecUnionLike {
  readonly kind?: 'union';
  readonly name: string;
  readonly doc?: string;
  readonly cases?: readonly SpecUnionCaseLike[];
}

export interface SpecEnumVariantLike {
  readonly name: string;
  readonly doc?: string;
  readonly value?: number;
}

export interface SpecEnumLike {
  readonly kind?: 'enum';
  readonly name: string;
  readonly doc?: string;
  readonly variants?: readonly SpecEnumVariantLike[];
}

export type SpecTypeLike = SpecStructLike | SpecUnionLike | SpecEnumLike;

export interface SpecErrorCaseLike {
  readonly enumName?: string;
  readonly name: string;
  readonly doc?: string;
  readonly value?: number;
}

export interface ContractSpecLike {
  readonly functions?: readonly SpecFunctionLike[];
  readonly types?: readonly SpecTypeLike[];
  readonly errors?: readonly SpecErrorCaseLike[];
}

/**
 * Splits a doc comment into paragraphs on blank lines (2+ newlines separated only by optional whitespace),
 * and splits each paragraph into lines on single newlines.
 *
 * Empty paragraphs or whitespace-only inputs return an empty array.
 */
export function parseDocCommentParagraphs(doc?: string | null): string[][] {
  if (!doc) return [];
  const trimmed = doc.trim();
  if (!trimmed) return [];

  // Split on blank lines: 2 or more newlines separated only by whitespace
  const rawParagraphs = trimmed.split(/\r?\n\s*\r?\n/);

  const paragraphs: string[][] = [];
  for (const rawP of rawParagraphs) {
    const p = rawP.trim();
    if (!p) continue;
    const lines = p.split(/\r?\n/);
    paragraphs.push(lines);
  }

  return paragraphs;
}

/**
 * Returns true if at least one function, user-defined type (including fields, cases, variants),
 * or error case in the contract specification carries a non-empty doc comment.
 *
 * When this returns false, the contract is completely undocumented and the
 * NO_DOC_COMMENTS_NOTE must be displayed. Partial documentation returns true.
 */
export function hasAnyDocComments(spec?: ContractSpecLike | null): boolean {
  if (!spec) return false;

  // Check functions
  if (spec.functions && spec.functions.some((fn) => Boolean(fn.doc && fn.doc.trim().length > 0))) {
    return true;
  }

  // Check types (structs, unions, enums, and their inner components)
  if (spec.types) {
    for (const t of spec.types) {
      if (t.doc && t.doc.trim().length > 0) return true;
      if ('fields' in t && t.fields?.some((f) => Boolean(f.doc && f.doc.trim().length > 0))) {
        return true;
      }
      if (
        'cases' in t &&
        t.cases?.some(
          (c) =>
            Boolean(c.doc && c.doc.trim().length > 0) ||
            c.fields?.some((f) => Boolean(f.doc && f.doc.trim().length > 0)),
        )
      ) {
        return true;
      }
      if ('variants' in t && t.variants?.some((v) => Boolean(v.doc && v.doc.trim().length > 0))) {
        return true;
      }
    }
  }

  // Check errors
  if (spec.errors && spec.errors.some((e) => Boolean(e.doc && e.doc.trim().length > 0))) {
    return true;
  }

  return false;
}

/**
 * Pure React element factory for plain-text doc comments.
 * Returns null if doc is empty or whitespace-only (never renders an empty <p>).
 * Renders paragraphs split on blank lines, single newlines preserved with <br/>,
 * and no HTML interpretation (React escapes all strings).
 */
export function renderDocComment(
  doc?: string | null,
  options?: { className?: string; pClassName?: string },
): React.ReactElement | null {
  const paragraphs = parseDocCommentParagraphs(doc);
  if (paragraphs.length === 0) return null;

  const pClassName = options?.pClassName ?? 'text-[13px] leading-[1.7] text-[#8a8779]';

  const children = paragraphs.map((lines, pIdx) => {
    const lineElements = lines.flatMap((line, lIdx) =>
      lIdx < lines.length - 1
        ? [line, React.createElement('br', { key: `br-${lIdx}` })]
        : [line],
    );
    return React.createElement(
      'p',
      {
        key: `p-${pIdx}`,
        className: pClassName,
        style: { fontFamily: 'var(--font-mono)' },
      },
      ...lineElements,
    );
  });

  if (children.length === 1) {
    return children[0]!;
  }

  return React.createElement(
    'div',
    { className: options?.className ?? 'space-y-3' },
    ...children,
  );
}

/**
 * Pure React element factory for the "no doc comments" note.
 */
export function renderNoDocCommentsNote(options?: { className?: string }): React.ReactElement {
  return React.createElement(
    'p',
    {
      className: options?.className ?? 'text-[13px] leading-[1.7] text-[#8a8779]',
      style: { fontFamily: 'var(--font-mono)' },
      'data-testid': 'no-doc-comments-note',
    },
    NO_DOC_COMMENTS_NOTE,
  );
}

/**
 * Formats a Soroban TypeRef into a concise readable string.
 */
export function formatTypeRef(type: any): string {
  if (!type) return 'val';
  if (typeof type === 'string') return type;
  if (type.type === 'bytes_n') return `bytes_n<${type.n}>`;
  if (type.type === 'option') return `Option<${formatTypeRef(type.value)}>`;
  if (type.type === 'result') return `Result<${formatTypeRef(type.ok)}, ${formatTypeRef(type.error)}>`;
  if (type.type === 'vec') return `Vec<${formatTypeRef(type.element)}>`;
  if (type.type === 'map') return `Map<${formatTypeRef(type.key)}, ${formatTypeRef(type.value)}>`;
  if (type.type === 'tuple') return `(${type.elements ? type.elements.map(formatTypeRef).join(', ') : ''})`;
  if (type.type === 'named') return type.name;
  return 'val';
}

/**
 * Formats a function signature string, e.g. `claim(handle: string, wallet: address) -> Result<void, Error>`.
 */
export function formatFunctionSignature(fn: SpecFunctionLike): string {
  const inputs = (fn.inputs ?? [])
    .map((input) => `${input.name ?? '_'}: ${formatTypeRef(input.type)}`)
    .join(', ');
  const outputStr = fn.outputs && fn.outputs.length > 0
    ? (fn.outputs.length === 1 ? formatTypeRef(fn.outputs[0]) : `(${fn.outputs.map(formatTypeRef).join(', ')})`)
    : undefined;

  return outputStr ? `${fn.name}(${inputs}) -> ${outputStr}` : `${fn.name}(${inputs})`;
}

/**
 * Pure React element factory for the full Functions tab list.
 * Renders the NO_DOC_COMMENTS_NOTE once at the top if zero functions/types/errors carry doc comments.
 * For each function, renders signature and doc comment (omitting any empty <p> tags).
 */
export function renderFunctionList(
  spec?: ContractSpecLike | null,
  options?: { className?: string },
): React.ReactElement {
  const hasDocs = hasAnyDocComments(spec);
  const functions = spec?.functions ?? [];

  const elements: React.ReactElement[] = [];

  // Top note if undocumented
  if (!hasDocs) {
    elements.push(
      React.createElement(
        'div',
        { key: 'no-docs-note', className: 'mb-8' },
        renderNoDocCommentsNote(),
      ),
    );
  }

  // Functions list
  const functionSections = functions.map((fn) => {
    const docElem = renderDocComment(fn.doc, { className: 'mt-3 space-y-3' });

    return React.createElement(
      'section',
      {
        key: `fn-${fn.name}`,
        id: `fn-${fn.name}`,
        className: 'border-b border-[#1f1d19] py-6 last:border-b-0',
      },
      React.createElement(
        'h3',
        {
          className: 'text-[14px] font-medium text-[#f5f4ee]',
          style: { fontFamily: 'var(--font-mono)' },
        },
        formatFunctionSignature(fn),
      ),
      docElem,
    );
  });

  elements.push(
    React.createElement(
      'div',
      { key: 'function-sections', className: 'divide-y divide-[#1f1d19]' },
      ...functionSections,
    ),
  );

  return React.createElement('div', { className: options?.className }, ...elements);
}
