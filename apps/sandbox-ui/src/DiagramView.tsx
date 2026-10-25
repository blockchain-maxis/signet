import { useEffect, useMemo, useRef, useState } from 'react';
import type { SpecJson } from '@signet/spec';
import { enhanceDetails } from '@signet/visualiser/interactive/details';
import { enhanceKeyboard } from '@signet/visualiser/interactive/keyboard';
import type { Api } from './api.ts';
import {
  buildDetails,
  decodeSpec,
  drawBuild,
  localMarks,
  storageRows,
  traceRows,
  truncationNotice,
  type TracedOutcome,
} from './diagram.ts';

type Load<T> = { state: 'loading' } | { state: 'ok'; value: T } | { state: 'error'; message: string };

const short = (s: string) => (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);

/**
 * The Diagram view (#580): this build's interface, redrawn on every cycle,
 * with what it changed against the deployed interface, marks from this
 * session's own runs, and the selected call's A and B call trees.
 */
export function DiagramView({
  api,
  contract,
  refresh,
  outcomes,
}: {
  api: Api;
  contract: string;
  refresh: number;
  outcomes: readonly TracedOutcome[];
}) {
  const [specs, setSpecs] = useState<Load<{ local: SpecJson; deployed: SpecJson | null }>>({
    state: 'loading',
  });
  const [selected, setSelected] = useState<string | null>(null);
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      api.get<SpecJson>('spec?wasm=local'),
      api.get<SpecJson>('spec?wasm=deployed').catch(() => null),
    ])
      .then(([local, deployed]) => live && setSpecs({ state: 'ok', value: { local, deployed } }))
      .catch((e: unknown) => {
        if (live) setSpecs({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      live = false;
    };
  }, [api, refresh]);

  const drawn = useMemo(
    () =>
      specs.state === 'ok'
        ? drawBuild({ contract, local: specs.value.local, deployed: specs.value.deployed, outcomes })
        : null,
    [specs, contract, outcomes],
  );

  // The web page's enhancers, mounted on each redraw.
  useEffect(() => {
    const svg = holder.current?.querySelector('svg');
    if (!svg || !drawn || specs.state !== 'ok') return;
    const spec = decodeSpec(specs.value.local);
    const { marks } = localMarks(spec, contract, outcomes);
    const undoDetails = enhanceDetails(svg, buildDetails(spec, marks, drawn.diff));
    const undoKeyboard = enhanceKeyboard(svg, { container: holder.current });
    return () => {
      undoDetails();
      undoKeyboard();
    };
  }, [drawn, specs, contract, outcomes]);

  if (specs.state === 'loading') {
    return (
      <div className="mt-4 space-y-2" aria-label="loading the build's interface">
        <div className="h-48 animate-pulse rounded bg-raised" />
      </div>
    );
  }
  if (specs.state === 'error' || !drawn) {
    return (
      <p className="mt-4 max-w-[65ch] text-sm text-muted">
        {specs.state === 'error' && /no build/.test(specs.message)
          ? 'No build yet. The diagram appears after the first successful build.'
          : `The build's interface could not be read: ${specs.state === 'error' ? specs.message : ''}`}
      </p>
    );
  }

  const { diff } = drawn;
  const outcome = outcomes.find((o) => o.name === selected) ?? outcomes[0] ?? null;
  return (
    <div className="mt-3 grid gap-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-xs text-muted">
        {diff && (diff.added.length || diff.changed.length || diff.removed.length) ? (
          <p>
            Against the deployed interface: {diff.added.length} added (+), {diff.changed.length}{' '}
            changed (~)
            {diff.removed.length ? `, removed: ${diff.removed.map((id) => id.split(':')[1]).join(', ')}` : ''}.
          </p>
        ) : (
          <p>The build has the deployed interface.</p>
        )}
        <p>
          {drawn.runs
            ? `Marks: ${drawn.runs} local sandbox run${drawn.runs === 1 ? '' : 's'}, on this machine only.`
            : 'No traced runs yet: saved calls fill in read/write marks on the next cycle.'}
        </p>
      </div>
      <div
        ref={holder}
        role="region"
        aria-label="This build's diagram"
        tabIndex={0}
        className="viz-viewport max-h-[70vh] overflow-auto rounded border border-line bg-page"
        dangerouslySetInnerHTML={{ __html: drawn.svg }}
      />
      {outcomes.length > 0 && outcome && (
        <TracePanel outcomes={outcomes} outcome={outcome} onSelect={setSelected} />
      )}
    </div>
  );
}

function TracePanel({
  outcomes,
  outcome,
  onSelect,
}: {
  outcomes: readonly TracedOutcome[];
  outcome: TracedOutcome;
  onSelect: (name: string) => void;
}) {
  const a = outcome.a.result?.trace;
  const b = outcome.b.result?.trace;
  const rows = traceRows(a, b);
  const notices = [truncationNotice(a), truncationNotice(b)].filter(Boolean);
  return (
    <section aria-labelledby="trace-heading" className="rounded border border-line p-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 id="trace-heading" className="text-sm font-semibold">
          Call trees
        </h3>
        <div role="group" aria-label="Saved call" className="flex flex-wrap gap-1.5">
          {outcomes.map((o) => (
            <button
              key={o.name}
              type="button"
              aria-pressed={o.name === outcome.name}
              onClick={() => onSelect(o.name)}
              className={`rounded border px-2 py-0.5 font-mono text-xs active:translate-y-px ${
                o.name === outcome.name ? 'border-accent text-ink' : 'border-line text-muted hover:text-ink'
              }`}
            >
              {o.name}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted">This call has no trace yet; it is traced on the next cycle.</p>
      ) : (
        <table className="mt-3 w-full border-collapse text-left font-mono text-xs">
          <thead className="text-muted">
            <tr className="border-b border-line">
              <th scope="col" className="py-1 pr-3 font-medium">
                Deployed (A)
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Build (B)
              </th>
              <th scope="col" className="py-1 font-medium">
                <span className="sr-only">Difference</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.index}
                data-differs={r.differs || undefined}
                className={`border-b border-line/60 align-top ${r.differs ? 'bg-raised' : ''}`}
              >
                {[r.a, r.b].map((f, side) => (
                  <td key={side} className="py-1 pr-3" style={{ paddingLeft: `${r.depth * 1.25}rem` }}>
                    {f ? (
                      <>
                        <span className="text-ink">{f.function}</span>
                        <span className="text-faint"> @{short(f.contract)}</span>
                        <span className={`ml-2 break-all ${f.failed ? 'text-bad' : 'text-muted'}`}>
                          {f.failed ? f.outcome : `→ ${f.outcome}`}
                        </span>
                      </>
                    ) : (
                      <span className="text-faint">not run</span>
                    )}
                  </td>
                ))}
                <td className={`whitespace-nowrap py-1 ${r.differs ? 'text-accent' : 'text-faint'}`}>
                  {r.differs ? 'differs' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {notices.map((n) => (
        <p key={n} className="mt-2 text-xs text-muted" role="note">
          {n}
        </p>
      ))}
      {b && (
        <ul className="mt-3 grid gap-1 text-xs text-muted" aria-label="Storage the build's run touched">
          {storageRows(b).map((s) => (
            <li key={s.contract} className="font-mono">
              <span className="text-ink">{short(s.contract)}</span>: {s.reads} read, {s.writes} read-write,{' '}
              {s.changed} changed
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
