import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { SandboxTrace } from '@signet/visualiser';
import { ApiError, createApi, takeToken, type Api, type SessionEvent } from './api.ts';
// The diagram brings the spec reader and the renderer: loaded on first use.
const DiagramView = lazy(() => import('./DiagramView.tsx').then((m) => ({ default: m.DiagramView })));

interface Session {
  contract: string;
  network: { name: string };
  fork: { id: string; ledger: number; time: string; consistent: boolean; drifted_entries: number };
  lane: number;
  crate: { name: string; manifest: string };
  build: string;
  config: { file: string; calls: number; overrides: number; ui_overrides: number };
}

interface Run {
  result?: { return_value?: unknown; return_value_xdr?: string; trace?: SandboxTrace };
  error?: { code: string; decoded?: { error_name?: string } };
  cached?: boolean;
}

interface Outcome {
  name: string;
  a: Run;
  b: Run;
  diff?: { summary: { breaking: number; behavioural: number; cost: number; ignored: number } };
  verdict?: { expect: string; pass: boolean; reason?: string };
}

interface Cycle {
  id: number;
  deployed: string;
  local: string;
  outcomes: Outcome[];
  simulations: number;
  restarted?: string[];
}

type Load<T> =
  { state: 'loading' } | { state: 'ok'; value: T } | { state: 'error'; message: string };

const short = (s: string, head = 4, tail = 3) =>
  s.length > head + tail + 1 ? `${s.slice(0, head)}…${tail > 0 ? s.slice(-tail) : ''}` : s;

function describeRun(r: Run): string {
  if (r.error) return `error ${r.error.decoded?.error_name ?? r.error.code}`;
  if (r.result?.return_value !== undefined) return JSON.stringify(r.result.return_value);
  return r.result?.return_value_xdr ?? 'no result';
}

function summarise(d: Outcome['diff']): string {
  if (!d) return '';
  const s = d.summary;
  const parts = [
    s.breaking && `${s.breaking} breaking`,
    s.behavioural && `${s.behavioural} behavioural`,
    s.cost && `${s.cost} cost`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'same';
}

function useLoad<T>(api: Api | null, path: string, refresh: number): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' });
  useEffect(() => {
    if (!api) return;
    let live = true;
    api
      .get<T>(path)
      .then((value) => live && setLoad({ state: 'ok', value }))
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404)
          setLoad({ state: 'error', message: 'none yet' });
        else setLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      live = false;
    };
  }, [api, path, refresh]);
  return load;
}

type View = 'cycle' | 'diagram';

/** The view in the fragment (`#view=diagram`), as `signet visualise --open` asks for it. */
function viewFromHash(): View {
  return new URLSearchParams(window.location.hash.replace(/^#/, '')).get('view') === 'diagram'
    ? 'diagram'
    : 'cycle';
}

export function App() {
  const token = useMemo(() => takeToken(), []);
  const [view, setView] = useState<View>(() => viewFromHash());
  const show = (next: View) => {
    setView(next);
    window.history.replaceState(null, '', next === 'diagram' ? '#view=diagram' : window.location.pathname);
  };
  const api = useMemo(() => (token ? createApi(token) : null), [token]);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [stream, setStream] = useState<'connecting' | 'live' | 'closed'>('connecting');
  const [cycleRefresh, setCycleRefresh] = useState(0);
  const session = useLoad<Session>(api, 'session', 0);
  const cycle = useLoad<Cycle>(api, 'cycles/latest', cycleRefresh);

  useEffect(() => {
    if (!api) return;
    const abort = new AbortController();
    setStream('live');
    api
      .events((e) => {
        setEvents((prev) => [e, ...prev].slice(0, 40));
        if (e.type === 'cycle.completed') setCycleRefresh((n) => n + 1);
      }, abort.signal)
      .catch(() => undefined)
      .finally(() => !abort.signal.aborted && setStream('closed'));
    return () => abort.abort();
  }, [api]);

  if (!api) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-16">
        <h1 className="text-lg font-semibold">This page needs the link signet dev printed</h1>
        <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-muted">
          The link carries this run&apos;s token after the{' '}
          <code className="font-mono text-ink">#</code>. Open it again from the terminal, or restart{' '}
          <code className="font-mono text-ink">signet dev --ui</code>.
        </p>
      </main>
    );
  }

  return (
    <div className="min-h-[100dvh]">
      <header className="flex min-h-12 flex-wrap items-center gap-x-6 gap-y-1 border-b border-line px-4 py-2 text-sm">
        <span className="whitespace-nowrap font-semibold">signet dev</span>
        {session.state === 'ok' ? (
          <dl className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1 font-mono text-xs text-muted">
            <div className="flex gap-1.5">
              <dt className="sr-only">contract</dt>
              <dd className="text-ink" title={session.value.contract}>
                {short(session.value.contract)}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt>network</dt>
              <dd className="text-ink">{session.value.network.name}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>ledger</dt>
              <dd className="text-ink">{session.value.fork.ledger}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>lane</dt>
              <dd className="text-ink">p{session.value.lane}</dd>
            </div>
            <div className="hidden gap-1.5 md:flex">
              <dt>crate</dt>
              <dd className="truncate text-ink">{session.value.crate.name}</dd>
            </div>
          </dl>
        ) : session.state === 'error' ? (
          <span className="text-bad">{session.message}</span>
        ) : (
          <span
            className="h-3 w-64 animate-pulse rounded bg-raised"
            aria-label="loading the session"
          />
        )}
        <span
          className="ml-auto flex items-center gap-2 whitespace-nowrap text-xs text-muted"
          role="status"
        >
          <span
            className={`inline-block h-2 w-2 rounded-full ${stream === 'live' ? 'bg-ok' : 'bg-bad'}`}
            aria-hidden="true"
          />
          {stream === 'live'
            ? 'live'
            : stream === 'closed'
              ? 'disconnected: is signet dev still running?'
              : 'connecting'}
        </span>
      </header>

      <main className="grid gap-px bg-line lg:grid-cols-[1fr_22rem]">
        <section aria-labelledby="cycle-heading" className="min-w-0 bg-page p-4">
          <nav aria-label="Views" className="mb-3 flex gap-1 text-sm">
            {(['cycle', 'diagram'] as const).map((v) => (
              <a
                key={v}
                href={v === 'diagram' ? '#view=diagram' : '#'}
                aria-current={view === v ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  show(v);
                }}
                className={`rounded border px-3 py-1 active:translate-y-px ${
                  view === v ? 'border-accent text-ink' : 'border-line text-muted hover:text-ink'
                }`}
              >
                {v === 'cycle' ? 'Cycle' : 'Diagram'}
              </a>
            ))}
          </nav>
          <div className="flex items-baseline gap-3">
            <h2 id="cycle-heading" className="text-sm font-semibold">
              {view === 'diagram' ? "This build's diagram" : 'Latest cycle'}
            </h2>
            {cycle.state === 'ok' && (
              <p className="font-mono text-xs text-muted">
                #{cycle.value.id} · {short(cycle.value.deployed, 8, 0)} deployed,{' '}
                {short(cycle.value.local, 8, 0)} build, {cycle.value.simulations} runs
                {cycle.value.restarted?.length
                  ? `, simulator restarted (${cycle.value.restarted.join(', ')})`
                  : ''}
              </p>
            )}
          </div>
          {view === 'diagram' ? (
            session.state === 'ok' ? (
              <Suspense
                fallback={
                  <div className="mt-4 h-48 animate-pulse rounded bg-raised" aria-label="loading the diagram" />
                }
              >
                <DiagramView
                  api={api}
                  contract={session.value.contract}
                  refresh={cycleRefresh}
                  outcomes={cycle.state === 'ok' ? cycle.value.outcomes : NO_OUTCOMES}
                />
              </Suspense>
            ) : null
          ) : (
            <CycleTable cycle={cycle} />
          )}
        </section>

        <aside aria-labelledby="events-heading" className="min-w-0 bg-page p-4">
          <h2 id="events-heading" className="text-sm font-semibold">
            Events
          </h2>
          {events.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Builds and cycles appear here as they happen.</p>
          ) : (
            <ol className="mt-3 space-y-1.5 font-mono text-xs">
              {events.map((e, i) => (
                <li
                  key={`${events.length - i}`}
                  className={e.type === 'build.failed' ? 'text-bad' : 'text-muted'}
                >
                  <span className="text-ink">{e.type}</span>
                  {e.data ? ` ${JSON.stringify(e.data).slice(0, 120)}` : ''}
                </li>
              ))}
            </ol>
          )}
        </aside>
      </main>
    </div>
  );
}

const NO_OUTCOMES: Outcome[] = [];

function CycleTable({ cycle }: { cycle: Load<Cycle> }) {
  if (cycle.state === 'loading') {
    return (
      <div className="mt-4 space-y-2" aria-label="loading the latest cycle">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-7 animate-pulse rounded bg-raised" />
        ))}
      </div>
    );
  }
  if (cycle.state === 'error') {
    return (
      <p className="mt-4 max-w-[65ch] text-sm text-muted">
        {cycle.message === 'none yet'
          ? 'No cycle yet. It runs after the first successful build; build errors show in the terminal and under Events.'
          : `The cycle could not be loaded: ${cycle.message}`}
      </p>
    );
  }
  if (cycle.value.outcomes.length === 0) {
    return (
      <p className="mt-4 max-w-[65ch] text-sm text-muted">
        This cycle had no saved calls. Add some with{' '}
        <code className="font-mono text-ink">signet sandbox call … --save</code>.
      </p>
    );
  }
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
        <thead className="text-xs text-muted">
          <tr className="border-b border-line">
            <th scope="col" className="py-1.5 pr-4 font-medium">
              Call
            </th>
            <th scope="col" className="py-1.5 pr-4 font-medium">
              Deployed (A)
            </th>
            <th scope="col" className="py-1.5 pr-4 font-medium">
              Build (B)
            </th>
            <th scope="col" className="py-1.5 pr-4 font-medium">
              Difference
            </th>
            <th scope="col" className="py-1.5 font-medium">
              Expect
            </th>
          </tr>
        </thead>
        <tbody className="font-mono text-xs">
          {cycle.value.outcomes.map((o) => (
            <tr key={o.name} className="border-b border-line/60 align-top">
              <th scope="row" className="min-w-[10rem] py-1.5 pr-4 font-sans text-sm font-normal">
                {o.name}
              </th>
              <td className="break-all py-1.5 pr-4 text-muted">
                {describeRun(o.a)}
                {o.a.cached ? <span className="ml-2 text-faint">cached</span> : null}
              </td>
              <td className="break-all py-1.5 pr-4">{describeRun(o.b)}</td>
              <td
                className={`whitespace-nowrap py-1.5 pr-4 ${summarise(o.diff) === 'same' ? 'text-muted' : 'text-accent'}`}
              >
                {summarise(o.diff)}
              </td>
              <td className="whitespace-nowrap py-1.5">
                {o.verdict ? (
                  <span
                    className={o.verdict.pass ? 'text-ok' : 'text-bad'}
                    title={o.verdict.reason}
                  >
                    {o.verdict.pass ? 'pass' : 'fail'} {o.verdict.expect}
                  </span>
                ) : (
                  <span className="text-faint">none</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
