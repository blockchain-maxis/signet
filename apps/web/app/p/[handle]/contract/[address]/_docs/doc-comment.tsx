import { renderDocComment, type DocRefs } from '@/lib/contract-docs';

export interface DocCommentProps {
  doc?: string | null;
  className?: string;
  pClassName?: string;
  /** Targets for intra-doc links like [`Foo`]. */
  refs?: DocRefs;
}

/**
 * Doc comment component (#469, #474, D-06/D-11).
 *
 * Renders the safe Markdown subset via `renderDocComment`: raw HTML is never
 * interpreted, links are http(s)-only with rel="nofollow ugc noopener", images
 * become text, headings are demoted. Absent or whitespace-only doc comments
 * render nothing.
 */
export function DocComment({ doc, className, pClassName, refs }: DocCommentProps) {
  return renderDocComment(doc, { className, pClassName, refs });
}
