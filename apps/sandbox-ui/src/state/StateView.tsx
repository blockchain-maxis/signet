import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SpecJson, TypeRef } from '@signet/spec';
import type { Api } from '../api.ts';
import { FieldInput } from '../call/FieldInput.tsx';
import { fieldOf, initialValue, toJson, type Errors, type Value } from '../call/fields.ts';
import {
  completeness,
  forkRows,
  isUiOverride,
  ttlLabel,
  typedExpression,
  type ForkEntry,
  type Layer,
  type Override,
} from './state.ts';

const PRIMITIVES = [
  'u32', 'i32', 'u64', 'i64', 'u128', 'i128', 'u256', 'i256',
  'bool', 'string', 'symbol', 'address', 'bytes', 'timepoint', 'duration',
] as const;

const control =
  'rounded border border-line bg-page px-2 py-1 font-mono text-xs text-ink focus:border-accent focus:outline-none';
const small = 'rounded border border-line px-2 py-0.5 text-xs text-muted hover:text-ink active:translate-y-px';

/** A storage expression typed into a form: a type, and a value of it, or the raw expression. */
function ExpressionInput({
  id,
  label,
  spec,
  initial,
  onChange,
  errors,
}: {
  id: string;
  label: string;
  spec: SpecJson | null;
  initial?: string;
  onChange: (build: () => { expression: string | null; errors: Errors }) => void;
  errors: Errors;
}) {
  const [mode, setMode] = useState<'typed' | 'raw'>(initial ? 'raw' : 'typed');
  const [raw, setRaw] = useState(initial ?? '');
  const [type, setType] = useState<string>('u32');
  const types = spec?.types.map((t) => t.name) ?? [];
  const field = useMemo(
    () => fieldOf((PRIMITIVES as readonly string[]).includes(type) ? (type as TypeRef) : { type: 'named', name: type }, spec?.types ?? []),
    [type, spec],
  );
  const [value, setValue] = useState<Value>(initialValue(field));
  useEffect(() => setValue(initialValue(field)), [field]);

  useEffect(() => {
    onChange(() => {
      if (mode === 'raw') {
        return raw.trim() ? { expression: raw.trim(), errors: {} } : { expression: null, errors: { [id]: 'required' } };
      }
      const errs: Errors = {};
      const json = toJson(field, value, id, errs);
      return Object.keys(errs).length ? { expression: null, errors: errs } : { expression: typedExpression(type, json), errors: {} };
    });
  }, [mode, raw, type, value, field, id, onChange]);

  return (
    <fieldset className="grid gap-2 rounded border border-line p-2">
      <legend className="px-1 text-xs text-muted">{label}</legend>
      <div role="radiogroup" aria-label={`${label} as`} className="flex gap-3 text-xs">
        {(['typed', 'raw'] as const).map((m) => (
          <label key={m} className="flex items-center gap-1.5">
            <input type="radio" name={`${id}-mode`} checked={mode === m} onChange={() => setMode(m)} />
            {m === 'typed' ? 'typed value' : 'storage expression'}
          </label>
        ))}
      </div>
      {mode === 'raw' ? (
        <label className="grid gap-1 text-xs">
          <span className="text-faint">Owner(&quot;alice&quot;), u32:5, address:&quot;G…&quot; or typed ScVal JSON</span>
          <input
            id={id}
            aria-label={`${label} expression`}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            aria-invalid={errors[id] ? true : undefined}
            className={control}
          />
          {errors[id] && <span role="alert" className="text-bad">{label}: {errors[id]}</span>}
        </label>
      ) : (
        <>
          <label className="grid gap-1 text-xs">
            <span className="text-muted">type</span>
            <select aria-label={`${label} type`} value={type} onChange={(e) => setType(e.target.value)} className={control}>
              <optgroup label="Primitive">
                {PRIMITIVES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </optgroup>
              {types.length > 0 && (
                <optgroup label="The contract's types">
                  {types.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          <FieldInput id={id} label={label} field={field} value={value} onChange={setValue} path={id} errors={errors} accounts={[]} />
        </>
      )}
    </fieldset>
  );
}

/** Adds an override: a durability, a key, and a value or unset (#559). */
export function OverrideEditor({
  api,
  spec,
  initialKey,
  initialDurability,
  onAdded,
}: {
  api: Api;
  spec: SpecJson | null;
  initialKey?: string;
  initialDurability?: string;
  onAdded: () => void;
}) {
  const [durability, setDurability] = useState(initialDurability ?? 'persistent');
  const [unset, setUnset] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [buildKey, setBuildKey] = useState<() => { expression: string | null; errors: Errors }>(() => () => ({ expression: null, errors: {} }));
  const [buildValue, setBuildValue] = useState<() => { expression: string | null; errors: Errors }>(() => () => ({ expression: null, errors: {} }));
  type Build = () => { expression: string | null; errors: Errors };
  const onKey = useCallback((f: Build) => setBuildKey(() => f), []);
  const onValue = useCallback((f: Build) => setBuildValue(() => f), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFailure(null);
    const key = buildKey();
    const value = unset ? { expression: null, errors: {} } : buildValue();
    const errs = { ...key.errors, ...value.errors };
    setErrors(errs);
    if (Object.keys(errs).length || !key.expression) return;
    try {
      await api.post('overrides', {
        durability,
        key: key.expression,
        ...(unset ? { unset: true } : { value: value.expression }),
      });
      onAdded();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-label="Add an override" className="grid gap-3 rounded border border-line p-3">
      <label className="grid gap-1 text-xs">
        <span className="text-muted">durability</span>
        <select value={durability} onChange={(e) => setDurability(e.target.value)} className={control}>
          <option value="instance">instance</option>
          <option value="persistent">persistent</option>
          <option value="temporary">temporary</option>
        </select>
      </label>
      <ExpressionInput id="override-key" label="key" spec={spec} {...(initialKey && { initial: initialKey })} onChange={onKey} errors={errors} />
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={unset} onChange={(e) => setUnset(e.target.checked)} />
        remove the key instead of setting it
      </label>
      {!unset && <ExpressionInput id="override-value" label="value" spec={spec} onChange={onValue} errors={errors} />}
      {failure && <p role="alert" className="text-xs text-bad">{failure}</p>}
      <div>
        <button type="submit" className="rounded border border-accent px-3 py-1 text-sm active:translate-y-px">
          Add override
        </button>
      </div>
    </form>
  );
}

/**
 * The state view (#583): the fork's entries, the overrides and the session,
 * with TTLs against the fork's ledger, drift marked, and whether the fork
 * holds all of the contract's storage or only what has been read.
 */
export function StateView({
  api,
  ledger,
  consistent,
  spec,
  refresh,
}: {
  api: Api;
  ledger: number;
  consistent: boolean;
  /** The spec whose types the override editor offers; fetched (deployed) when left out. */
  spec?: SpecJson | null;
  refresh: number;
}) {
  const [fetchedSpec, setFetchedSpec] = useState<SpecJson | null>(null);
  useEffect(() => {
    if (spec !== undefined) return;
    api.get<SpecJson>('spec?wasm=deployed').then(setFetchedSpec, () => setFetchedSpec(null));
  }, [api, spec]);
  const types = spec === undefined ? fetchedSpec : spec;
  const [layer, setLayer] = useState<Layer>('fork');
  const [entries, setEntries] = useState<ForkEntry[] | null>(null);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [sessionNote, setSessionNote] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ key?: string; durability?: string } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    Promise.all([
      api.get<{ entries: ForkEntry[] }>('state?layer=fork'),
      api.get<{ overrides: Override[] }>('state?layer=override'),
      api.get<{ note?: string }>('state?layer=session'),
    ])
      .then(([fork, ov, session]) => {
        if (!live) return;
        setEntries(fork.entries);
        setOverrides(ov.overrides);
        setSessionNote(session.note ?? '');
      })
      .catch((e: unknown) => live && setFailure(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [api, refresh, reload]);

  const rows = useMemo(() => forkRows(entries ?? []), [entries]);

  async function remove(ids: string[]) {
    for (const id of ids) await api.del(`overrides/${encodeURIComponent(id)}`);
    setReload((n) => n + 1);
  }

  if (failure) return <p role="alert" className="mt-3 text-sm text-bad">The state could not be read: {failure}</p>;
  if (!entries) return <div className="mt-4 h-48 animate-pulse rounded bg-raised" role="status" aria-label="loading the state" />;

  const uiOverrides = overrides.filter(isUiOverride);
  return (
    <div className="mt-3 grid gap-4">
      <p className="text-xs text-muted" data-testid="completeness">{completeness(consistent, ledger)}</p>
      <div role="tablist" aria-label="Layer" className="flex gap-1 text-sm">
        {(['fork', 'override', 'session'] as const).map((l) => (
          <button
            key={l}
            type="button"
            role="tab"
            aria-selected={layer === l}
            onClick={() => setLayer(l)}
            className={`rounded border px-3 py-1 ${layer === l ? 'border-accent text-ink' : 'border-line text-muted hover:text-ink'}`}
          >
            {l === 'fork' ? `Fork (${rows.length})` : l === 'override' ? `Overrides (${overrides.length})` : 'Session'}
          </button>
        ))}
      </div>

      {layer === 'fork' &&
        (rows.length === 0 ? (
          <p className="text-sm text-muted">The fork holds no entries yet: they are fetched as calls read them.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-left text-xs">
              <thead className="text-muted">
                <tr className="border-b border-line">
                  <th scope="col" className="py-1 pr-3 font-medium">Key</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Value</th>
                  <th scope="col" className="py-1 pr-3 font-medium">TTL</th>
                  <th scope="col" className="py-1 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {rows.map((r, i) => {
                  const ttl = ttlLabel(r.liveUntil, ledger);
                  return (
                    <tr key={i} className="border-b border-line align-top" data-drifted={r.drifted || undefined}>
                      <td className="break-all py-1 pr-3 text-ink">
                        {r.label}
                        {r.drifted && (
                          <span className="ml-2 rounded border border-accent px-1 font-sans text-accent" title="changed on-chain after the fork's ledger">
                            drifted
                          </span>
                        )}
                      </td>
                      <td className="break-all py-1 pr-3 text-muted">{r.value}</td>
                      <td className={`py-1 pr-3 ${ttl.archived ? 'text-bad' : 'text-muted'}`}>{ttl.text}</td>
                      <td className="py-1">
                        {r.keyExpression && r.durability && (
                          <button type="button" className={small} onClick={() => setEditing({ key: r.keyExpression!, durability: r.durability! })} aria-label={`override ${r.label}`}>
                            Override
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

      {layer === 'override' && (
        <div className="grid gap-2">
          {overrides.length === 0 ? (
            <p className="text-sm text-muted">No overrides. Add one below, or in signet.dev.toml.</p>
          ) : (
            <ul className="grid gap-1 font-mono text-xs">
              {overrides.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-2">
                  <span className="text-ink">{o.durability} {o.key}</span>
                  <span className="text-muted">{o.unset ? 'removed' : `= ${o.value}`}</span>
                  {isUiOverride(o) ? (
                    <button type="button" className={small} onClick={() => remove([o.id])} aria-label={`delete override ${o.key}`}>
                      Delete
                    </button>
                  ) : (
                    <span className="font-sans text-faint">from signet.dev.toml</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {uiOverrides.length > 0 && (
            <div>
              <button type="button" className={small} onClick={() => remove(uiOverrides.map((o) => o.id))}>
                Reset the session (remove the UI&apos;s {uiOverrides.length} override{uiOverrides.length === 1 ? '' : 's'})
              </button>
            </div>
          )}
        </div>
      )}

      {layer === 'session' && <p className="text-sm text-muted">{sessionNote || 'The session holds no writes of its own.'}</p>}

      {editing ? (
        <OverrideEditor
          key={`${editing.durability}-${editing.key}`}
          api={api}
          spec={types}
          {...(editing.key && { initialKey: editing.key })}
          {...(editing.durability && { initialDurability: editing.durability })}
          onAdded={() => {
            setEditing(null);
            setReload((n) => n + 1);
          }}
        />
      ) : (
        <div>
          <button type="button" className={small} onClick={() => setEditing({})}>
            Add an override
          </button>
        </div>
      )}
    </div>
  );
}
