import type { SpecJson } from '@signet/spec';
import {
  errorDoc,
  forkAge,
  requiredSigners,
  resultKind,
  storageWrites,
  type CallResultView,
} from './result.ts';

/** The line every write preview carries: nothing left this machine. */
export const NOTHING_SUBMITTED = 'Local sandbox: nothing was submitted.';

const TITLES = {
  read: 'Read',
  write: 'Write preview',
  'contract-error': 'Contract error',
  'host-error': 'Host error',
} as const;

function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted">nothing (void)</span>;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <span className="break-all text-ink">{typeof value === 'string' ? value : String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted">empty list</span>;
    return (
      <ol className="list-decimal pl-5">
        {value.map((v, i) => (
          <li key={i}>
            <Value value={v} />
          </li>
        ))}
      </ol>
    );
  }
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3">
      {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd>
            <Value value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One call's result (#582) in the design note's three meanings of success: a
 * read's value; a write, framed as a preview naming its signers; a contract
 * error, as an outcome the contract chose. A host error is shown apart.
 * Every result carries where it ran, and the raw XDR is folded away.
 */
export function ResultPanel({
  result,
  target,
  fn,
  spec,
  now = Date.now(),
}: {
  result: CallResultView;
  target: 'deployed' | 'local';
  fn: string;
  spec: SpecJson | null;
  now?: number;
}) {
  const kind = resultKind(result);
  const signers = requiredSigners(result);
  const writes = storageWrites(result);
  const doc = errorDoc(result, spec);
  const age = forkAge(result.forkTime, now);
  const drifted = result.drift?.keys?.length ?? 0;
  const overrides = result.storageOverrides?.length ?? 0;
  const frame =
    kind === 'host-error' ? 'border-bad' : kind === 'write' ? 'border-accent' : 'border-line';

  return (
    <article aria-label={`${TITLES[kind]}: ${fn}`} data-kind={kind} className={`rounded border ${frame} p-3 text-xs`}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 tabIndex={-1} className="text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">{TITLES[kind]}</h3>
        <span className="font-mono text-muted">
          {fn} on the {target === 'local' ? 'local build' : 'deployed code'}
        </span>
      </header>

      {/* Provenance (§6.1): where and against what the call ran. */}
      <ul aria-label="Provenance" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-faint">
        {result.network && <li>{result.network}</li>}
        {result.forkLedger !== undefined && (
          <li>
            fork ledger {result.forkLedger}
            {age ? `, ${age} old` : ''}
          </li>
        )}
        <li>{drifted ? `${drifted} drifted entr${drifted === 1 ? 'y' : 'ies'}` : 'no drift seen'}</li>
        {overrides > 0 && <li>{overrides} storage override{overrides === 1 ? '' : 's'}</li>}
        {result.authMode && result.authMode !== 'enforce' && (
          <li className="rounded border border-line px-1 text-muted" title="require_auth was approved, signatures were not checked">
            auth mocked ({result.authMode})
          </li>
        )}
        {(result.budget || result.unlimited) && <li>budget overridden</li>}
      </ul>

      <div className="mt-3">
        {kind === 'read' && (
          <div className="font-mono">
            <Value value={result.returnValue} />
          </div>
        )}
        {kind === 'write' && (
          <div className="grid gap-2">
            <p className="font-medium text-ink" data-testid="nothing-submitted">
              {NOTHING_SUBMITTED}
            </p>
            <p className="text-muted">
              Submitting this would need{' '}
              {signers.length ? (
                <>
                  {signers.length === 1 ? 'a signature from ' : 'signatures from '}
                  {signers.map((s, i) => (
                    <span key={s} className="font-mono text-ink">
                      {i > 0 ? ', ' : ''}
                      {s}
                    </span>
                  ))}
                </>
              ) : (
                "only the source account's signature"
              )}
              .
            </p>
            {result.returnValue !== undefined && result.returnValue !== null && (
              <div className="font-mono">
                <span className="text-muted">returns </span>
                <Value value={result.returnValue} />
              </div>
            )}
          </div>
        )}
        {kind === 'contract-error' && (
          <div className="grid gap-1">
            <p className="font-mono text-ink">
              {result.error?.decoded?.error_name ?? result.error?.message}
              {result.error?.decoded?.error_value !== undefined && (
                <span className="text-muted"> (code {result.error.decoded.error_value})</span>
              )}
            </p>
            <p className="text-muted">
              The contract returned this error on purpose: an expected outcome, not a crash.
              {doc ? ` ${doc}` : ''}
            </p>
          </div>
        )}
        {kind === 'host-error' && (
          <div className="grid gap-1">
            <p className="font-mono text-bad">{result.error?.code ?? 'host error'}</p>
            <p className="text-muted">
              The host stopped the call before the contract could finish: {result.error?.message ?? 'no message'}.
            </p>
          </div>
        )}
      </div>

      {writes.length > 0 && (
        <table className="mt-3 w-full border-collapse text-left">
          <caption className="text-left text-muted">Storage writes</caption>
          <thead className="text-muted">
            <tr className="border-b border-line">
              <th scope="col" className="py-1 pr-3 font-medium">Key</th>
              <th scope="col" className="py-1 pr-3 font-medium">Change</th>
              <th scope="col" className="py-1 font-medium">Live until</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {writes.map((w, i) => (
              <tr key={i} className="border-b border-line">
                <td className="break-all py-1 pr-3">{w.key}</td>
                <td className="py-1 pr-3">{w.change}</td>
                <td className="py-1">{w.liveUntil ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(result.events?.length ?? 0) > 0 && (
        <div className="mt-3">
          <h4 className="text-muted">Events</h4>
          <ol className="mt-1 grid gap-1 font-mono">
            {result.events!.map((e, i) => (
              <li key={i}>
                <span className="text-ink">{(e.decoded?.topics ?? []).map((t) => String(t)).join(' · ') || e.type}</span>
                {e.decoded?.data !== undefined && <span className="text-muted"> {JSON.stringify(e.decoded.data)}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}

      <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-muted">
        {result.resources?.instructions !== undefined && (
          <div className="flex gap-1">
            <dt>instructions</dt>
            <dd className="text-ink">{result.resources.instructions.toLocaleString('en-US')}</dd>
          </div>
        )}
        {result.resources?.disk_read_bytes !== undefined && (
          <div className="flex gap-1">
            <dt>read</dt>
            <dd className="text-ink">{result.resources.disk_read_bytes} B</dd>
          </div>
        )}
        {result.resources?.write_bytes !== undefined && (
          <div className="flex gap-1">
            <dt>written</dt>
            <dd className="text-ink">{result.resources.write_bytes} B</dd>
          </div>
        )}
        {result.fee?.resource_fee !== undefined && (
          <div className="flex gap-1">
            <dt>resource fee</dt>
            <dd className="text-ink">{result.fee.resource_fee} stroops</dd>
          </div>
        )}
      </dl>

      <details className="mt-3">
        <summary className="cursor-pointer text-muted hover:text-ink">Raw XDR</summary>
        <pre className="mt-2 max-h-60 overflow-auto break-all font-mono text-faint">
          {[
            result.returnValueXdr && `return ${result.returnValueXdr}`,
            ...(result.events ?? []).map((e) => e.event_xdr && `event ${e.event_xdr}`),
            ...(result.modifiedEntries ?? []).map((e) => `write ${e.key_xdr} -> ${e.after_xdr ?? 'deleted'}`),
          ]
            .filter(Boolean)
            .join('\n')}
        </pre>
      </details>
    </article>
  );
}
