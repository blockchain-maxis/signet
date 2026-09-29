import React from 'react';
import {
  hasAnyDocComments,
  formatFunctionSignature,
  type ContractSpecLike,
  type SpecFunctionLike,
} from '@/lib/contract-docs';
import { DocComment } from './doc-comment';
import { NoDocCommentsNote } from './no-doc-comments-note';

export interface FunctionListProps {
  spec?: ContractSpecLike | null;
  functions?: readonly SpecFunctionLike[];
  className?: string;
}

/**
 * Server component rendering the contract functions list (#466, #469).
 *
 * Rules:
 * - When zero functions, types, and errors carry a doc comment, show the note once at the top.
 * - When at least one function, type, or error carries a doc comment, show NO note.
 * - Each function renders its signature and plain text doc comment (via DocComment).
 * - Undocumented functions render no empty paragraph element (<p></p>).
 */
export function FunctionList({ spec, functions: explicitFunctions, className }: FunctionListProps) {
  const functions = explicitFunctions ?? spec?.functions ?? [];
  const showNoDocNote = !hasAnyDocComments(spec);

  return (
    <div className={className}>
      {showNoDocNote && (
        <div className="mb-8" data-slot="no-doc-comments-note">
          <NoDocCommentsNote />
        </div>
      )}

      <div className="divide-y divide-[#1f1d19]">
        {functions.map((fn) => (
          <section
            key={fn.name}
            id={`fn-${fn.name}`}
            className="border-b border-[#1f1d19] py-6 last:border-b-0"
          >
            <h3
              className="text-[14px] font-medium text-[#f5f4ee]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {formatFunctionSignature(fn)}
            </h3>

            {fn.doc && (
              <div className="mt-3">
                <DocComment doc={fn.doc} />
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
