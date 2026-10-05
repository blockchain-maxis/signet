import { docRefsFromSpec } from '@/lib/contract-docs';
import { buildErrorReference } from '@/lib/docs/error-reference';
import { typesTabHref, type FunctionReferenceSpec } from '@/lib/docs/function-reference';
import { SectionLabel } from '../../../_components/section-label';
import { DocComment } from './doc-comment';

export interface ErrorListProps {
  spec: FunctionReferenceSpec;
  handle: string;
  address: string;
  className?: string;
}

const MONO = { fontFamily: 'var(--font-mono)' } as const;
const DISPLAY = { fontFamily: 'var(--font-display)' } as const;

const TH = 'px-4 py-2.5 text-[10px] font-normal uppercase tracking-[0.22em] text-[#8a8779]';

/**
 * The Types tab's Errors section (#468, design §2.3): one table per error
 * enum with each case's code, name and doc comment. It says how a failure
 * reads on chain, and says that a shared number is ambiguous only when two
 * enums really do share one. A contract with no error enum renders nothing,
 * not an empty heading.
 *
 * Each row's `id` is `errorAnchor(enum, case)`, the target the Functions tab's
 * "Can fail with" names can link to.
 */
export function ErrorList({ spec, handle, address, className }: ErrorListProps) {
  const reference = buildErrorReference(spec);
  if (!reference) return null;
  const refs = docRefsFromSpec(spec, typesTabHref(handle, address));

  return (
    <section aria-label="Errors" data-testid="error-list" className={className}>
      <SectionLabel>Errors</SectionLabel>
      <div
        className="mt-3 max-w-[65ch] space-y-2 text-[12px] leading-[1.7] text-[#8a8779]"
        style={MONO}
      >
        <p data-testid="error-on-chain-note">{reference.onChainNote}</p>
        {reference.sharedNote && <p data-testid="error-shared-code-note">{reference.sharedNote}</p>}
      </div>

      {reference.tables.map((table) => (
        <div key={table.enumName} className="mt-8" data-testid="error-table">
          <h3 className="text-[20px] font-bold tracking-[-0.015em] text-[#f5f4ee]" style={DISPLAY}>
            {table.enumName}
          </h3>
          <table className="mt-4 w-full max-w-[720px] border border-[#1f1d19] text-left">
            <caption className="sr-only">Error codes of {table.enumName}</caption>
            <thead>
              <tr className="border-b border-[#1f1d19]">
                <th scope="col" className={TH} style={MONO}>
                  Code
                </th>
                <th scope="col" className={TH} style={MONO}>
                  Name
                </th>
                <th scope="col" className={TH} style={MONO}>
                  Doc
                </th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr
                  key={row.id}
                  id={row.id}
                  data-testid="error-row"
                  className="scroll-mt-24 border-b border-[#1f1d19] align-top last:border-b-0"
                >
                  <td className="px-4 py-2.5 text-[13px] tabular-nums text-[#f5f4ee]" style={MONO}>
                    {row.code}
                  </td>
                  <th
                    scope="row"
                    className="px-4 py-2.5 text-[13px] font-normal text-[#f5f4ee]"
                    style={MONO}
                  >
                    {row.name}
                  </th>
                  <td className="px-4 py-2.5">
                    <DocComment
                      doc={row.doc}
                      refs={refs}
                      pClassName="text-[13px] leading-[1.7] text-[#b8b5a8]"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}
