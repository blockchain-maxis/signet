import React from 'react';
import { NO_DOC_COMMENTS_NOTE } from '@/lib/contract-docs';

export interface NoDocCommentsNoteProps {
  className?: string;
}

/**
 * The single honest note displayed at the top of the Functions tab
 * when zero functions, types, and errors in the contract build carry doc comments (#469).
 */
export function NoDocCommentsNote({ className }: NoDocCommentsNoteProps) {
  return (
    <p
      className={className ?? 'text-[13px] leading-[1.7] text-[#8a8779]'}
      style={{ fontFamily: 'var(--font-mono)' }}
      data-testid="no-doc-comments-note"
    >
      {NO_DOC_COMMENTS_NOTE}
    </p>
  );
}

export { NO_DOC_COMMENTS_NOTE };
