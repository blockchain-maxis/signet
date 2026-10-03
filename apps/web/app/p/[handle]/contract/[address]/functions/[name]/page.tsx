import { notFound } from 'next/navigation';
import { attributeContract } from '@/lib/contract-attribution';
import {
  ERROR_SCOPE_NOTE,
  functionArguments,
  functionBacklinkHref,
  functionPermalinkDescription,
  functionPermalinkHref,
  functionPermalinkTitle,
  functionReturnType,
  functionSignature,
  renderTypeRef,
  resolveFunctionPage,
  type FunctionPageState,
} from '@/lib/docs/function-permalink';
import { SectionLabel } from '../../../../_components/section-label';
import { CopyLink } from './copy-link';
import { loadContractSpec } from './function-source';

interface RouteParams {
  handle: string;
  address: string;
  name: string;
}

/**
 * Resolve the page's content, shared by `generateMetadata` and the page
 * component.
 *
 * The 404 rules are the shell's, applied by calling the same
 * `attributeContract` the layout calls rather than by re-deriving them: a
 * contract this handle did not deploy is a 404, and so is a function name the
 * interface does not export. `attributeContract` is wrapped in React's `cache`,
 * so the second call in a request is the first one's result rather than a
 * second round trip.
 *
 * `unavailable` also ends in a 404, which looks stricter than the shell. It is
 * not a different rule: the layout renders its own "cannot be decided" state
 * instead of children, so this function is never reached in that case, and
 * throwing is the way to guarantee the page cannot render a contract nobody
 * proved this handle deployed if that layout branch ever changes.
 */
async function readFunctionPage(
  handle: string,
  address: string,
  name: string,
): Promise<FunctionPageState> {
  const attribution = await attributeContract(handle, address);
  if (attribution.status !== 'attributed') notFound();
  const source = await loadContractSpec({ address, wasmHash: attribution.contract.wasmHash });
  return resolveFunctionPage(source, name);
}

export async function generateMetadata({ params }: { params: Promise<RouteParams> }) {
  const { handle, address, name } = await params;
  const title = functionPermalinkTitle({ name, address, handle });
  const state = await readFunctionPage(handle, address, name);
  // A description is only ever the contract's own words or its own signature.
  // A page whose interface could not be read gets the title alone, because
  // there is nothing on the deployed WASM to describe it with.
  if (state.kind !== 'function') return { title };
  return { title, description: functionPermalinkDescription(state.fn) };
}

/**
 * Doc comments are plain text here. #474 owns the markdown subset, and a
 * permalink that renders whatever a doc comment happens to contain before then
 * would be a page that can be broken by a contract's own comment.
 */
function docParagraphs(doc: string | undefined): string[] {
  if (!doc) return [];
  return doc
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function Prose({ doc }: { doc: string | undefined }) {
  const paragraphs = docParagraphs(doc);
  if (paragraphs.length === 0) return null;
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <p
          key={index}
          className="mt-4 text-[14px] leading-[1.7] text-[#b8b5a8] first:mt-0"
        >
          {paragraph}
        </p>
      ))}
    </>
  );
}

export default async function ContractFunctionPage({ params }: { params: Promise<RouteParams> }) {
  const { handle, address, name } = await params;
  const state = await readFunctionPage(handle, address, name);

  // The interface was read and does not export this name, so the URL is wrong.
  if (state.kind === 'unknown-function') notFound();

  if (state.kind === 'interface-unavailable') {
    // Not a 404. Whether this function exists is unknown, and a 404 would
    // blame a URL that is probably right.
    return (
      <section>
        <SectionLabel>Function</SectionLabel>
        <h1
          className="mt-6 text-[28px] font-bold tracking-[-0.02em] text-[#f5f4ee]"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {name}
        </h1>
        <p
          className="mt-4 text-[13px] leading-[1.7] text-[#5e5b51]"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          This contract&apos;s interface could not be read, so nothing is shown here rather
          than something Signet did not read from the deployed code.
        </p>
        <a
          href={functionBacklinkHref(handle, address, name)}
          className="mt-6 inline-block text-[10px] uppercase tracking-[0.2em] text-[#8b1a1a] transition-colors hover:text-[#c2410c]"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          All functions
        </a>
      </section>
    );
  }

  const { fn, referencedTypes, errors } = state;
  const args = functionArguments(fn);

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <a
          href={functionBacklinkHref(handle, address, fn.name)}
          className="text-[10px] uppercase tracking-[0.2em] text-[#5e5b51] transition-colors hover:text-[#c2410c]"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          All functions
        </a>
        <CopyLink
          href={functionPermalinkHref(handle, address, fn.name)}
          label={fn.name}
        />
      </div>

      <h1
        className="mt-8 text-[40px] font-bold leading-[1.05] tracking-[-0.025em] text-[#f5f4ee] md:text-[56px]"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {fn.name}
      </h1>

      <p
        className="mt-5 break-words text-[13px] leading-[1.7] text-[#b8b5a8]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        <code>{functionSignature(fn)}</code>
      </p>

      <Prose doc={fn.doc} />

      {args.length > 0 && (
        <div className="mt-10">
          <SectionLabel>Arguments</SectionLabel>
          <table className="mt-4 w-full border border-[#1f1d19] text-left">
            <thead>
              <tr className="border-b border-[#1f1d19]">
                <th
                  scope="col"
                  className="px-5 py-3 text-[10px] uppercase tracking-[0.22em] text-[#5e5b51]"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  Name
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 text-[10px] uppercase tracking-[0.22em] text-[#5e5b51]"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  Type
                </th>
              </tr>
            </thead>
            <tbody>
              {args.map((arg) => (
                <tr key={arg.name} className="border-b border-[#1f1d19] last:border-b-0">
                  <th
                    scope="row"
                    className="px-5 py-3 text-[13px] font-normal text-[#f5f4ee]"
                    style={{ fontFamily: 'var(--font-mono)' }}
                  >
                    {arg.name}
                    {arg.doc ? (
                      <span className="mt-1 block text-[12px] leading-[1.6] text-[#5e5b51]">
                        {arg.doc}
                      </span>
                    ) : null}
                  </th>
                  <td
                    className="px-5 py-3 align-top text-[13px] text-[#b8b5a8]"
                    style={{ fontFamily: 'var(--font-mono)' }}
                  >
                    {arg.type}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-10">
        <SectionLabel>Returns</SectionLabel>
        <p
          className="mt-4 text-[13px] text-[#b8b5a8]"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {functionReturnType(fn)}
        </p>
      </div>

      {/*
        A reader following an argument type has to land somewhere (design
        §2.3), so each referenced type is inlined here, one level deep. A type
        this function's signature does not name belongs to the Types tab, and
        duplicating the whole surface here would put two lists out of step.
      */}
      {referencedTypes.map((type) => (
        <div key={type.name} className="mt-10" id={`type-${type.name}`}>
          <SectionLabel>Type</SectionLabel>
          <h2
            className="mt-4 text-[20px] font-bold tracking-[-0.015em] text-[#f5f4ee]"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {type.name}
          </h2>
          <Prose doc={type.doc} />
          <ul
            className="mt-4 space-y-2 text-[13px] text-[#b8b5a8]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {type.kind === 'struct' &&
              type.fields.map((field) => (
                <li key={field.name} className="break-words">
                  {field.name}: {renderTypeRef(field.type)}
                </li>
              ))}
            {type.kind === 'union' &&
              type.cases.map((unionCase) => (
                <li key={unionCase.name} className="break-words">
                  {unionCase.name}
                  {unionCase.fields.length > 0
                    ? `(${unionCase.fields.map((field) => renderTypeRef(field.type)).join(', ')})`
                    : null}
                </li>
              ))}
            {type.kind === 'enum' &&
              type.variants.map((variant) => (
                <li key={variant.name} className="break-words">
                  {variant.name} = {variant.value}
                </li>
              ))}
          </ul>
        </div>
      ))}

      {errors.length > 0 && (
        <div className="mt-10">
          <SectionLabel>Can fail with</SectionLabel>
          <ul
            className="mt-4 space-y-2 text-[13px] text-[#b8b5a8]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {errors.map((error) => (
              <li key={error.name} className="break-words">
                {error.name}
                {typeof error.value === 'number' ? ` = ${error.value}` : null}
                {error.doc ? (
                  <span className="mt-1 block text-[12px] leading-[1.6] text-[#5e5b51]">
                    {error.doc}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <p
            className="mt-4 text-[12px] leading-[1.7] text-[#5e5b51]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {ERROR_SCOPE_NOTE}
          </p>
        </div>
      )}
    </section>
  );
}
