import React from 'react';
import { parseDocCommentParagraphs } from '@/lib/contract-docs';

export interface DocCommentProps {
  doc?: string | null;
  className?: string;
  pClassName?: string;
}

/**
 * Plain-text doc comment component (#469, D-06).
 *
 * Rules:
 * - Absent or whitespace-only doc comments render NOTHING (returns null, no empty <p>).
 * - Paragraphs are split on blank lines (2+ newlines).
 * - Single newlines within a paragraph are preserved using <br />.
 * - Text is rendered as plain text (no HTML interpretation; React escapes HTML entities).
 */
export function DocComment({ doc, className, pClassName }: DocCommentProps) {
  const paragraphs = parseDocCommentParagraphs(doc);
  if (paragraphs.length === 0) {
    return null;
  }

  const paragraphClass = pClassName ?? 'text-[13px] leading-[1.7] text-[#8a8779]';

  const children = paragraphs.map((lines, pIdx) => (
    <p
      key={pIdx}
      className={paragraphClass}
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      {lines.map((line, lIdx) => (
        <React.Fragment key={lIdx}>
          {line}
          {lIdx < lines.length - 1 ? <br /> : null}
        </React.Fragment>
      ))}
    </p>
  ));

  if (children.length === 1) {
    return children[0];
  }

  return (
    <div className={className ?? 'space-y-3'}>
      {children}
    </div>
  );
}
