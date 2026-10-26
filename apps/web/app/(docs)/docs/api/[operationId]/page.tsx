import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  curlExample,
  exampleResponse,
  findOperation,
  listOperations,
  loadApiDocument,
  responseSchema,
  schemaRows,
  sdkExample,
  typeLabel,
  type ApiDocument,
  type ApiSchema,
} from '@/lib/docs/api-reference';
import { appUrl } from '@/lib/public-env';
import { CodeBlock } from '../_components/code-block';
import { DocsShell, Endpoint, SectionHeading, SubHeading, prose } from '../_components/docs-shell';

// The page set is fixed at build time: one per operation in the snapshot.
// Each still renders per request, as every route does, for the CSP nonce
// (app/layout.tsx).
export const dynamicParams = false;

type Props = { params: Promise<{ operationId: string }> };

const mono = { fontFamily: 'var(--font-mono)' } as const;

/** One page per operation in the snapshot, generated at build time. */
export function generateStaticParams() {
  return listOperations(loadApiDocument()).map((o) => ({ operationId: o.operationId }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const op = findOperation(loadApiDocument(), (await params).operationId);
  return op
    ? {
        title: `${op.summary ?? op.operationId} · Signet API`,
        description: `${op.method} /api/v1${op.path}`,
      }
    : {};
}

function SchemaTable({
  doc,
  schema,
  caption,
}: {
  doc: ApiDocument;
  schema: ApiSchema;
  caption: string;
}) {
  const rows = schemaRows(doc, schema);
  if (!rows.length) {
    return <p className={prose}>{typeLabel(doc, schema)}</p>;
  }
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-left text-[13px] leading-[1.6]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-[#1f1d19] text-[#8a8779]">
            <th scope="col" className="py-2 pr-4 font-normal">
              Field
            </th>
            <th scope="col" className="py-2 pr-4 font-normal">
              Type
            </th>
            <th scope="col" className="py-2 font-normal">
              Description
            </th>
          </tr>
        </thead>
        <tbody className="text-[#b8b5a8]">
          {rows.map((r) => (
            <tr key={r.name} className="border-b border-[#1f1d19] last:border-0 align-top">
              <td
                className="py-2 pr-4 text-[#f5f4ee]"
                style={{ ...mono, paddingLeft: `${r.depth * 14}px` }}
              >
                {r.name.split('.').pop()}
                {r.required ? '' : <span className="text-[#8a8779]">?</span>}
              </td>
              <td className="py-2 pr-4 break-words" style={mono}>
                {r.type}
              </td>
              <td className="py-2">{r.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `/docs/api/{operationId}` (#649): one endpoint, from the committed snapshot. */
export default async function OperationPage({ params }: Props) {
  const doc = loadApiDocument();
  const op = findOperation(doc, (await params).operationId);
  if (!op) notFound();

  const origin = appUrl();
  const curl = curlExample(`${origin}/api/v1`, op);
  const sdk = sdkExample(origin, op);
  const example = exampleResponse(doc, op);
  const ok = responseSchema(op, '200');
  const statuses = Object.entries(op.responses);
  const params_ = op.parameters ?? [];

  return (
    <DocsShell crumb={{ href: '/docs/api', label: 'API' }}>
      <h1
        className="text-[36px] font-bold leading-[1.05] tracking-[-0.02em] md:text-[48px]"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {op.summary ?? op.operationId}
      </h1>
      <Endpoint method={op.method} path={op.path} />
      {op.description && <p className={prose}>{op.description}</p>}

      <SectionHeading id="parameters">Parameters</SectionHeading>
      {params_.length === 0 ? (
        <p className={prose}>None.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left text-[13px] leading-[1.6]">
            <caption className="sr-only">Parameters</caption>
            <thead>
              <tr className="border-b border-[#1f1d19] text-[#8a8779]">
                <th scope="col" className="py-2 pr-4 font-normal">
                  Name
                </th>
                <th scope="col" className="py-2 pr-4 font-normal">
                  In
                </th>
                <th scope="col" className="py-2 pr-4 font-normal">
                  Type
                </th>
                <th scope="col" className="py-2 font-normal">
                  Description
                </th>
              </tr>
            </thead>
            <tbody className="text-[#b8b5a8]">
              {params_.map((p) => (
                <tr
                  key={`${p.in}-${p.name}`}
                  className="border-b border-[#1f1d19] last:border-0 align-top"
                >
                  <td className="py-2 pr-4 text-[#f5f4ee]" style={mono}>
                    {p.name}
                    {p.required ? '' : <span className="text-[#8a8779]">?</span>}
                  </td>
                  <td className="py-2 pr-4" style={mono}>
                    {p.in}
                  </td>
                  <td className="py-2 pr-4" style={mono}>
                    {typeLabel(doc, p.schema)}
                  </td>
                  <td className="py-2">{p.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionHeading id="example-request">Example request</SectionHeading>
      <CodeBlock code={curl} label="curl example" />
      {sdk ? (
        <CodeBlock code={sdk} label="@signet/sdk example" />
      ) : (
        <p className={prose}>
          <code>@signet/sdk</code> has no method for this endpoint; use the URL directly.
        </p>
      )}

      <SectionHeading id="responses">Responses</SectionHeading>
      {statuses.map(([status, res]) => {
        const schema = responseSchema(op, status);
        const type = Object.keys(res.content ?? {})[0];
        return (
          <section key={status} aria-labelledby={`status-${status}`}>
            <SubHeading id={`status-${status}`}>
              {status}
              {res.description ? ` · ${res.description}` : ''}
            </SubHeading>
            {type && type !== 'application/json' && (
              <p className={prose}>
                Body: <code>{type}</code>
              </p>
            )}
            {res.headers && (
              <p className={prose}>
                Headers:{' '}
                {Object.keys(res.headers).map((h, i) => (
                  <span key={h}>
                    {i > 0 && ', '}
                    <code>{h}</code>
                  </span>
                ))}
              </p>
            )}
            {status === '200' && schema && (
              <SchemaTable doc={doc} schema={schema} caption={`Fields of a ${status} response`} />
            )}
          </section>
        );
      })}

      {example && ok && (
        <>
          <SectionHeading id="example-response">Example response</SectionHeading>
          <p className={prose}>Generated from the schema; real values differ.</p>
          <CodeBlock code={example} label="example response" />
        </>
      )}
    </DocsShell>
  );
}
