import { useEffect, useRef, useState } from 'react';
import type { SpecJson } from '@signet/spec';
import type { Api } from '../api.ts';
import { forkAccounts } from './accounts.ts';
import { CallForm, type CallRun } from './CallForm.tsx';
import { ResultPanel } from '../results/ResultPanel.tsx';
import type { CallResultView } from '../results/result.ts';
import { SaveReplayForm } from './SaveReplayForm.tsx';

/**
 * The Call view (#581): the spec-generated form over the deployed interface
 * and the build's, with the fork's accounts offered for addresses, and each
 * run's answer below it in the results panel (#582).
 */
export function CallView({
  api,
  refresh,
  contract,
  network,
  buildPath,
}: {
  api: Api;
  refresh: number;
  contract?: string;
  network?: string;
  buildPath?: string;
}) {
  const [specs, setSpecs] = useState<{ deployed: SpecJson | null; local: SpecJson | null } | null>(null);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [runs, setRuns] = useState<CallRun[]>([]);
  const results = useRef<HTMLElement>(null);

  // After a run, focus moves to its result (#586), so a keyboard or screen
  // reader user lands on what happened.
  useEffect(() => {
    if (runs.length) results.current?.querySelector<HTMLElement>('h3')?.focus();
  }, [runs]);

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
    return <div className="mt-4 h-64 animate-pulse rounded bg-raised" role="status" aria-label="loading the interface" />;
  }
  return (
    <>
      <CallForm
        api={api}
        specs={specs}
        accounts={accounts}
        contract={contract}
        network={network}
        buildPath={buildPath}
        onRuns={(r) => setRuns(r)}
      />
      {runs.length > 0 && (
        <section ref={results} aria-label="Results" className="mt-4 grid gap-3">
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
          {(() => {
            const successful = runs.find((r) => r.result && !r.error);
            return successful ? (
              <SaveReplayForm
                api={api}
                run={successful}
                spec={successful.target === 'local' ? specs.local : specs.deployed}
              />
            ) : null;
          })()}
        </section>
      )}
    </>
  );
}
