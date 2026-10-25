import { useEffect, useState } from 'react';
import type { SpecJson } from '@signet/spec';
import type { Api } from '../api.ts';
import { forkAccounts } from './accounts.ts';
import { CallForm, type CallRun } from './CallForm.tsx';

/**
 * The Call view (#581): the spec-generated form over the deployed interface
 * and the build's, with the fork's accounts offered for addresses, and each
 * run's answer below it.
 */
export function CallView({ api, refresh }: { api: Api; refresh: number }) {
  const [specs, setSpecs] = useState<{ deployed: SpecJson | null; local: SpecJson | null } | null>(null);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [runs, setRuns] = useState<CallRun[]>([]);

  useEffect(() => {
    let live = true;
    Promise.all([
      api.get<SpecJson>('spec?wasm=deployed').catch(() => null),
      api.get<SpecJson>('spec?wasm=local').catch(() => null),
      api.get<{ entries: { key: string }[] }>('state?layer=fork').catch(() => ({ entries: [] })),
    ]).then(([deployed, local, fork]) => {
      if (!live) return;
      setSpecs({ deployed, local });
      setAccounts(forkAccounts(fork.entries));
    });
    return () => {
      live = false;
    };
  }, [api, refresh]);

  if (!specs) {
    return <div className="mt-4 h-64 animate-pulse rounded bg-raised" aria-label="loading the interface" />;
  }
  return (
    <>
      <CallForm api={api} specs={specs} accounts={accounts} onRuns={(r) => setRuns(r)} />
      {runs.length > 0 && (
        <section aria-label="Results" className="mt-4 grid gap-3">
          {runs.map((run) => (
            <div key={run.target} className="rounded border border-line p-3">
              <h3 className="text-xs text-muted">
                <span className="font-mono text-ink">{run.function}</span> on the{' '}
                {run.target === 'local' ? 'local build' : 'deployed code'}
              </h3>
              <pre className="mt-2 max-h-80 overflow-auto font-mono text-xs text-muted">
                {run.error ?? JSON.stringify(run.result, null, 2)}
              </pre>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
