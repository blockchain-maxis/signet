import { useEffect, useMemo, useState } from 'react';
import { StrKey } from '@stellar/stellar-sdk';
import { functionArgsSchema, type SpecJson } from '@signet/spec';
import { ApiError, type Api } from '../api.ts';
import { FieldInput } from './FieldInput.tsx';
import {
  argsJson,
  checkSchema,
  formFor,
  initialValue,
  serverFieldError,
  type Errors,
  type Value,
} from './fields.ts';

export type Target = 'deployed' | 'local';
export type RunOn = Target | 'both';

/** One run's answer from `POST /api/call`, as the CLI's call result shapes it. */
export interface CallResult {
  readonly outcome?: 'result' | 'contract_error';
  readonly modifiedEntries?: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface CallRun {
  readonly target: Target;
  readonly function: string;
  readonly result?: CallResult;
  readonly error?: string;
}

type Kind = 'read' | 'write';

/** What a function was seen doing in a run: a write if it changed any entry. */
export function classify(result: CallResult): Kind {
  return (result.modifiedEntries?.length ?? 0) > 0 ? 'write' : 'read';
}

/** Read/write by `<wasm hash>:<function>`, from dry runs and real ones, for this tab. */
const seen = new Map<string, Kind>();

export function __resetClassification(): void {
  seen.clear();
}

const button =
  'rounded border px-3 py-1 text-sm active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60';

/**
 * The spec-generated call form (#581): a function picker grouped by what
 * each function was seen doing, a widget per argument, the source account,
 * auth mode and ledger moves, and which code to run it on.
 */
export function CallForm({
  api,
  specs,
  accounts = [],
  onRuns,
}: {
  api: Api;
  specs: { deployed: SpecJson | null; local: SpecJson | null };
  accounts?: readonly string[];
  onRuns?: (runs: CallRun[]) => void;
}) {
  const [runOn, setRunOn] = useState<RunOn>(specs.deployed ? 'deployed' : 'local');
  const spec = (runOn === 'deployed' ? specs.deployed : specs.local) ?? specs.deployed ?? specs.local;
  const functions = useMemo(() => (spec ? spec.functions.filter((f) => !f.isConstructor) : []), [spec]);
  const [fn, setFn] = useState<string>(functions[0]?.name ?? '');
  const args = useMemo(() => (spec && fn ? formFor(spec, fn) : []), [spec, fn]);
  const [values, setValues] = useState<Record<string, Value>>({});
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [authMode, setAuthMode] = useState<'record' | 'strict'>('record');
  const [sequence, setSequence] = useState('');
  const [timestamp, setTimestamp] = useState('');
  const [pending, setPending] = useState(false);
  const [, setClassified] = useState(0);
  const key = (name: string) => `${spec?.wasmHash ?? ''}:${name}`;

  // A function with no arguments is dry-run once to see whether it writes.
  useEffect(() => {
    if (!spec) return;
    let live = true;
    const target: Target = spec === specs.deployed ? 'deployed' : 'local';
    for (const f of functions) {
      if (f.inputs.length > 0 || seen.has(key(f.name))) continue;
      api
        .post<CallResult>('call', { function: f.name, args: {}, wasm: target })
        .then((r) => {
          seen.set(key(f.name), classify(r));
          if (live) setClassified((n) => n + 1);
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [api, spec]);

  useEffect(() => {
    if (!functions.some((f) => f.name === fn)) setFn(functions[0]?.name ?? '');
  }, [functions, fn]);

  if (!spec) {
    return <p className="mt-3 text-sm text-muted">No interface to call yet: the deployed spec and the build are both missing.</p>;
  }

  const groups: [string, typeof functions][] = [
    ['Write', functions.filter((f) => seen.get(key(f.name)) === 'write')],
    ['Read', functions.filter((f) => seen.get(key(f.name)) === 'read')],
    ['Not run yet', functions.filter((f) => !seen.has(key(f.name)))],
  ];
  const doc = functions.find((f) => f.name === fn)?.doc;

  function pick(name: string) {
    setFn(name);
    setValues({});
    setErrors({});
    setFormError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const built = argsJson(args, values);
    const errs: Errors = { ...built.errors };
    if (Object.keys(errs).length === 0) {
      try {
        Object.assign(errs, checkSchema(functionArgsSchema(spec!, fn) as Record<string, unknown>, built.args));
      } catch {
        // a spec the schema generator cannot read: the server checks instead
      }
    }
    if (source.trim() && !StrKey.isValidEd25519PublicKey(source.trim())) errs.$source = 'expected a G… account';
    if (sequence.trim() && !/^\d+$/.test(sequence.trim())) errs.$sequence = 'expected a ledger number';
    if (timestamp.trim() && !/^\d+$/.test(timestamp.trim())) errs.$timestamp = 'expected seconds since 1970';
    setErrors(errs);
    if (Object.keys(errs).length) return;

    const body = {
      function: fn,
      args: built.args,
      auth_mode: authMode,
      ...(source.trim() && { source_account: source.trim() }),
      ...((sequence.trim() || timestamp.trim()) && {
        ledger: {
          ...(sequence.trim() && { sequence: Number(sequence.trim()) }),
          ...(timestamp.trim() && { timestamp: Number(timestamp.trim()) }),
        },
      }),
    };
    const targets: Target[] = runOn === 'both' ? ['deployed', 'local'] : [runOn];
    setPending(true);
    const runs: CallRun[] = [];
    for (const target of targets) {
      try {
        const result = await api.post<CallResult>('call', { ...body, wasm: target });
        seen.set(`${(target === 'deployed' ? specs.deployed : specs.local)?.wasmHash ?? ''}:${fn}`, classify(result));
        runs.push({ target, function: fn, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const field = err instanceof ApiError ? serverFieldError(message, args) : null;
        if (field) setErrors((prev) => ({ ...prev, [field.path]: field.message }));
        else setFormError(message);
        runs.push({ target, function: fn, error: message });
      }
    }
    setPending(false);
    onRuns?.(runs);
  }

  const control = 'rounded border border-line bg-page px-2 py-1 font-mono text-xs text-ink focus:border-accent focus:outline-none';
  return (
    <div className="mt-3 grid gap-4 lg:grid-cols-[14rem_1fr]">
      <nav aria-label="Functions" className="grid content-start gap-3">
        {groups.map(([title, list]) =>
          list.length ? (
            <div key={title}>
              <h3 className="text-xs text-muted">{title}</h3>
              <ul className="mt-1 grid gap-0.5">
                {list.map((f) => (
                  <li key={f.name}>
                    <button
                      type="button"
                      onClick={() => pick(f.name)}
                      aria-current={f.name === fn ? 'true' : undefined}
                      title={f.doc || undefined}
                      className={`w-full truncate rounded px-2 py-0.5 text-left font-mono text-xs ${
                        f.name === fn ? 'bg-raised text-ink' : 'text-muted hover:text-ink'
                      }`}
                    >
                      {f.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null,
        )}
      </nav>

      <form onSubmit={submit} noValidate aria-label={`Call ${fn}`} className="grid content-start gap-3">
        <div>
          <h3 className="font-mono text-sm text-ink">{fn}</h3>
          {doc && <p className="mt-0.5 max-w-[65ch] text-xs text-muted">{doc}</p>}
        </div>
        {args.length === 0 && <p className="text-xs text-muted">No arguments.</p>}
        {args.map((a) => (
          <FieldInput
            key={`${fn}-${a.name}`}
            id={`arg-${a.name}`}
            label={a.name}
            {...(a.doc && { doc: a.doc })}
            field={a.field}
            value={values[a.name] ?? initialValue(a.field)}
            onChange={(v) => setValues((prev) => ({ ...prev, [a.name]: v }))}
            path={a.name}
            errors={errors}
            accounts={accounts}
          />
        ))}
        {accounts.length > 0 && (
          <datalist id="fork-accounts">
            {accounts.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        )}

        <fieldset className="grid gap-2 rounded border border-line p-2 text-xs sm:grid-cols-2">
          <legend className="px-1 text-muted">Run</legend>
          <label className="grid gap-1">
            <span className="text-muted">source account</span>
            <input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="the fork's default"
              list={accounts.length ? 'fork-accounts' : undefined}
              aria-invalid={errors.$source ? true : undefined}
              className={control}
            />
            {errors.$source && <span role="alert" className="text-bad">source account: {errors.$source}</span>}
          </label>
          <label className="grid gap-1">
            <span className="text-muted">auth</span>
            <select value={authMode} onChange={(e) => setAuthMode(e.target.value as 'record' | 'strict')} className={control}>
              <option value="record">record: approve and list (signatures unchecked)</option>
              <option value="strict">strict: also refuse auth below the root call</option>
            </select>
          </label>
          <label className="grid gap-1">
            <span className="text-muted">ledger sequence</span>
            <input value={sequence} onChange={(e) => setSequence(e.target.value)} placeholder="the fork's" inputMode="numeric" className={control} />
            {errors.$sequence && <span role="alert" className="text-bad">ledger sequence: {errors.$sequence}</span>}
          </label>
          <label className="grid gap-1">
            <span className="text-muted">ledger time (unix seconds)</span>
            <input value={timestamp} onChange={(e) => setTimestamp(e.target.value)} placeholder="the fork's" inputMode="numeric" className={control} />
            {errors.$timestamp && <span role="alert" className="text-bad">ledger time: {errors.$timestamp}</span>}
          </label>
          <div role="radiogroup" aria-label="Run on" className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <span className="text-muted">run on</span>
            {(['deployed', 'local', 'both'] as const).map((t) => (
              <label key={t} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="run-on"
                  value={t}
                  checked={runOn === t}
                  disabled={(t !== 'deployed' && !specs.local) || (t !== 'local' && !specs.deployed)}
                  onChange={() => setRunOn(t)}
                />
                {t === 'local' ? 'local build' : t}
              </label>
            ))}
          </div>
        </fieldset>

        {formError && (
          <p role="alert" className="max-w-[65ch] text-xs text-bad">
            {formError}
          </p>
        )}
        <div>
          <button type="submit" disabled={pending} className={`${button} border-accent text-ink`}>
            {pending ? 'Running…' : runOn === 'both' ? 'Run on both' : 'Run'}
          </button>
        </div>
      </form>
    </div>
  );
}
