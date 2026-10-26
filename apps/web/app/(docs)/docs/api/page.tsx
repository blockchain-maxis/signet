import Link from 'next/link';
import { HTTP_STATUS_BY_CODE } from '@/lib/api/v1/http';
import { listOperations, loadApiDocument } from '@/lib/docs/api-reference';
import { appUrl } from '@/lib/public-env';
import { LIMITS } from '@/lib/rate-limit-policy';
import { CodeBlock } from './_components/code-block';
import { DocsShell, SectionHeading, prose } from './_components/docs-shell';

export const metadata = {
  title: 'API reference · Signet',
  description:
    'The public, read-only Signet API: base URL, keys, rate limits, errors, pagination, CORS and every endpoint.',
};

const mono = { fontFamily: 'var(--font-mono)' } as const;

/** What each error code means, from docs/API_V1.md's Envelope section. */
const ERROR_MEANING: Record<string, string> = {
  bad_request: 'The request is malformed or a parameter is invalid. Do not retry.',
  unauthorized: 'An invalid or revoked API key was sent. Do not retry.',
  not_found: 'The resource does not exist (for a handle: it is not bound). Do not retry.',
  rate_limited: 'Over budget. Retry after the Retry-After header.',
  unavailable: 'A dependency (database, chain RPC, Horizon) could not answer. Retry with backoff.',
  internal: 'A bug in Signet. The response carries no internals.',
};

/**
 * `/docs/api` (#649): the overview of the v1 API, from docs/API_V1.md's rules
 * and the committed OpenAPI snapshot read on the server. No client
 * script beyond the copy buttons, and nothing loaded from a CDN, so the
 * site's CSP is unchanged.
 */
export default function ApiOverviewPage() {
  const doc = loadApiDocument();
  const ops = listOperations(doc);
  const base = `${appUrl()}/api/v1`;
  const tags = [...new Set(ops.map((o) => o.tags?.[0] ?? 'Other'))];

  return (
    <DocsShell>
      <h1
        className="text-[44px] font-bold leading-[0.96] tracking-[-0.025em] md:text-[64px]"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        API reference
      </h1>
      <p className="mt-6 max-w-[600px] text-[15px] leading-[1.7] text-[#8a8779]">
        Signet&apos;s public API is read-only and versioned: every endpoint answers a GET with JSON
        (one returns an SVG badge), and v1 only ever changes by adding things. It is what{' '}
        <code>@signet/sdk</code> reads.
      </p>

      <SectionHeading id="base-url">Base URL</SectionHeading>
      <p className={prose}>
        Every path below is relative to the deployment&apos;s <code>/api/v1</code>. The version is
        in the path; there is no version header.
      </p>
      <CodeBlock code={`curl -s "${base}/health"`} label="base URL example" />

      <SectionHeading id="keys">Authentication and API keys</SectionHeading>
      <p className={prose}>
        No key is needed: anonymous callers can read everything. A key is a rate-limit identity, not
        a permission. Send it as a bearer token for the higher keyed budget, and keep it
        server-side. An invalid or revoked key is a <code>401</code>, never silently anonymous.
      </p>
      <CodeBlock
        code={`curl -s -H "Authorization: Bearer sgk_…" "${base}/profiles/alice"`}
        label="API key example"
      />

      <SectionHeading id="rate-limits">Rate limits</SectionHeading>
      <p className={prose}>
        Anonymous callers get {LIMITS.v1Read} requests per minute per IP; a key raises that to{' '}
        {LIMITS.v1Keyed} by default. Every response carries <code>RateLimit-Limit</code>,{' '}
        <code>RateLimit-Remaining</code> and <code>RateLimit-Reset</code> (seconds), so a client can
        pace itself. Over the limit is a <code>429</code> with <code>Retry-After</code> in seconds.
      </p>

      <SectionHeading id="errors">Errors</SectionHeading>
      <p className={prose}>
        A response has either <code>data</code> or <code>error</code>, never both. Branch on{' '}
        <code>error.code</code>, a closed list; <code>message</code> is for logs and may change.
      </p>
      <CodeBlock
        code={`{ "error": { "code": "not_found", "message": "No profile for handle 'nobody'.", "details": {} } }`}
        label="error envelope"
      />
      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-left text-[13px] leading-[1.6]">
          <caption className="sr-only">Error codes and their HTTP statuses</caption>
          <thead>
            <tr className="border-b border-[#1f1d19] text-[#8a8779]">
              <th scope="col" className="py-2 pr-4 font-normal" style={mono}>
                code
              </th>
              <th scope="col" className="py-2 pr-4 font-normal" style={mono}>
                status
              </th>
              <th scope="col" className="py-2 font-normal">
                Meaning
              </th>
            </tr>
          </thead>
          <tbody className="text-[#b8b5a8]">
            {Object.entries(HTTP_STATUS_BY_CODE).map(([code, status]) => (
              <tr key={code} className="border-b border-[#1f1d19] last:border-0 align-top">
                <td className="py-2 pr-4 text-[#f5f4ee]" style={mono}>
                  {code}
                </td>
                <td className="py-2 pr-4" style={mono}>
                  {status}
                </td>
                <td className="py-2">{ERROR_MEANING[code] ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionHeading id="pagination">Pagination</SectionHeading>
      <p className={prose}>
        Lists take <code>limit</code> (default 25, at most 100) and an opaque <code>cursor</code>.
        Pass <code>meta.nextCursor</code> back for the next page; it is <code>null</code> on the
        last one. A cursor is a position, not an offset, so items added while you page never repeat
        or shift a page. <code>meta.truncated</code> says a list may be partial (a capped read, or
        no layer able to answer), and <code>meta.source</code> which layer answered.
      </p>
      <CodeBlock
        code={`curl -s "${base}/profiles/alice/contracts?limit=25"\ncurl -s "${base}/profiles/alice/contracts?limit=25&cursor=<meta.nextCursor>"`}
        label="pagination example"
      />

      <SectionHeading id="cors">CORS and caching</SectionHeading>
      <p className={prose}>
        Every response sends <code>Access-Control-Allow-Origin: *</code>, so a browser on any site
        can call the API; the API is read-only, so there are no credentials to protect. Cacheable
        answers carry a weak <code>ETag</code> and honour <code>If-None-Match</code> with a{' '}
        <code>304</code>; errors are <code>no-store</code>.
      </p>

      <SectionHeading id="endpoints">Endpoints</SectionHeading>
      {tags.map((tag) => (
        <section key={tag} aria-labelledby={`tag-${tag}`}>
          <h3
            id={`tag-${tag}`}
            className="mt-8 text-[13px] font-medium text-[#f5f4ee]"
            style={mono}
          >
            {tag}
          </h3>
          <ul className="mt-2">
            {ops
              .filter((o) => (o.tags?.[0] ?? 'Other') === tag)
              .map((o) => (
                <li key={o.operationId} className="border-b border-[#1f1d19] last:border-0">
                  <Link
                    href={`/docs/api/${o.operationId}`}
                    className="group grid gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-6"
                  >
                    <span
                      className="text-[13px] text-[#f5f4ee] group-hover:text-[var(--text-accent)]"
                      style={mono}
                    >
                      <span className="mr-2 text-[#8a8779]">{o.method}</span>
                      {o.path}
                    </span>
                    <span className="text-[13px] text-[#b8b5a8]">{o.summary}</span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      ))}

      <p className="mt-14 border-t border-[#1f1d19] pt-6 text-[13px] leading-[1.7] text-[#8a8779]">
        The machine-readable document is at <code>/api/v1/openapi.json</code>. The full design
        rules, including what counts as a breaking change, are in{' '}
        <a
          href="https://github.com/blockchain-maxis/signet/blob/main/docs/API_V1.md"
          className="text-[var(--text-accent)] underline-offset-4 hover:underline"
        >
          docs/API_V1.md
        </a>
        .
      </p>
    </DocsShell>
  );
}
