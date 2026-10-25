import { useEffect, useState } from 'react';
import type { SpecJson } from '@signet/spec';
import type { Api } from '../api.ts';
import { forkAccounts } from './accounts.ts';
import { CallForm, type CallRun } from './CallForm.tsx';
import { ResultPanel } from '../results/ResultPanel.tsx';
import type { CallResultView } from '../results/result.ts';

/**
 * The Call view (#581): the spec-generated form over the deployed interface
 * and the build's, with the fork's accounts offered for addresses, and each
 * run's answer below it in the results panel (#582).
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
          {runs.map((run) =>
            run.result ? (
              <ResultPanel
                key={run.target}
                result={run.result as CallResultView}
                target={run.target}
                fn={run.function}
                spec={run.target === 'local' ? specs.local : specs.deployed}
              />
            ) : (
              <p key={run.target} role="alert" className="rounded border border-bad p-3 text-xs text-bad">
                {run.function} on the {run.target === 'local' ? 'local build' : 'deployed code'} did not run: {run.error}
              </p>
            ),
          )}
        </section>
      )}
    </>
  );
}
