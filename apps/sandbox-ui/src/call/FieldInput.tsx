import type { Errors, Field, Value } from './fields.ts';
import { initialValue } from './fields.ts';

const input =
  'w-full rounded border border-line bg-page px-2 py-1 font-mono text-xs text-ink placeholder:text-faint focus:border-accent focus:outline-none aria-[invalid=true]:border-bad';
const small =
  'rounded border border-line px-2 py-0.5 text-xs text-muted hover:text-ink active:translate-y-px';

function hint(field: Field): string {
  switch (field.kind) {
    case 'address':
      return field.muxed ? 'G…, C… or M… address' : 'G… or C… address';
    case 'int':
      return field.type === 'u32' ? '0 to 4294967295' : '-2147483648 to 2147483647';
    case 'bigint':
      return field.type.startsWith('u') || field.type === 'timepoint' || field.type === 'duration'
        ? `${field.type}, a whole number from 0`
        : `${field.type}, a whole number`;
    case 'bytes':
      return field.length !== undefined ? `hex, ${field.length} bytes` : 'hex';
    case 'text':
      return field.type === 'symbol' ? 'symbol: letters, digits, _' : 'text';
    case 'raw':
      return `${field.type} as JSON`;
    default:
      return '';
  }
}

/**
 * One argument's widget, by its spec type (#581): text with checks for
 * addresses, integers and bytes, a toggle for an Option, rows for a Vec or
 * Map, a fieldset for a struct, a variant select for a union or enum.
 */
export function FieldInput({
  id,
  label,
  doc,
  field,
  value,
  onChange,
  path,
  errors,
  accounts,
}: {
  id: string;
  label: string;
  doc?: string;
  field: Field;
  value: Value;
  onChange: (v: Value) => void;
  path: string;
  errors: Errors;
  accounts: readonly string[];
}) {
  const error = errors[path];
  const errorId = `${id}-error`;
  const describedBy = [doc ? `${id}-doc` : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined;
  const labelEl = (
    <label htmlFor={id} className="block text-xs text-muted">
      <span className="font-mono text-ink">{label}</span>
      {hint(field) && <span className="ml-2 text-faint"> {hint(field)}</span>}
    </label>
  );
  const after = (
    <>
      {doc && (
        <p id={`${id}-doc`} className="mt-0.5 text-xs text-faint">
          {doc}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-0.5 text-xs text-bad">
          {label}: {error}
        </p>
      )}
    </>
  );
  const nested = (sub: string, subLabel: string, f: Field, v: Value, set: (v: Value) => void, subDoc?: string) => (
    <FieldInput
      key={sub}
      id={`${id}-${sub.replace(/[^A-Za-z0-9_-]/g, '-')}`}
      label={subLabel}
      {...(subDoc && { doc: subDoc })}
      field={f}
      value={v}
      onChange={set}
      path={`${path}${sub.startsWith('[') ? '' : '.'}${sub}`}
      errors={errors}
      accounts={accounts}
    />
  );

  switch (field.kind) {
    case 'bool':
      return (
        <div>
          <label className="flex items-center gap-2 text-xs">
            <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
            <span className="font-mono text-ink">{label}</span>
          </label>
          {after}
        </div>
      );
    case 'option': {
      const v = value as { present: boolean; value: Value };
      return (
        <fieldset className="rounded border border-line p-2">
          <legend className="px-1 text-xs">
            <span className="font-mono text-ink">{label}</span> <span className="text-faint">optional</span>
          </legend>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={v.present}
              onChange={(e) => onChange({ ...v, present: e.target.checked })}
              aria-label={`give ${label} a value (unchecked sends none)`}
            />
            <span aria-hidden="true">{v.present ? 'has a value' : 'none'}</span>
          </label>
          {v.present && (
            <div className="mt-2">
              {nested('value', label, field.inner, v.value, (inner) => onChange({ ...v, value: inner }))}
            </div>
          )}
          {after}
        </fieldset>
      );
    }
    case 'vec':
    case 'map': {
      const rows = value as Value[];
      const isMap = field.kind === 'map';
      return (
        <fieldset className="rounded border border-line p-2">
          <legend className="px-1 font-mono text-xs text-ink">
            {label} <span className="font-sans text-faint">{isMap ? 'map' : 'list'}, {rows.length}</span>
          </legend>
          <ol className="space-y-2">
            {rows.map((row, i) => (
              <li key={i} className="flex items-start gap-2">
                <div className="grid flex-1 gap-2">
                  {isMap
                    ? [
                        nested(`[${i}].key`, `key ${i + 1}`, field.key, (row as [Value, Value])[0], (k) =>
                          onChange(rows.map((r, j) => (j === i ? [k, (r as [Value, Value])[1]] : r)) as Value)),
                        nested(`[${i}].value`, `value ${i + 1}`, field.value, (row as [Value, Value])[1], (v) =>
                          onChange(rows.map((r, j) => (j === i ? [(r as [Value, Value])[0], v] : r)) as Value)),
                      ]
                    : nested(`[${i}]`, `${label}[${i}]`, field.item, row, (v) =>
                        onChange(rows.map((r, j) => (j === i ? v : r)) as Value))}
                </div>
                <button
                  type="button"
                  className={small}
                  onClick={() => onChange(rows.filter((_, j) => j !== i) as Value)}
                  aria-label={`remove ${isMap ? 'entry' : 'item'} ${i + 1} of ${label}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className={`${small} mt-2`}
            onClick={() =>
              onChange([
                ...rows,
                isMap ? [initialValue(field.key), initialValue(field.value)] : initialValue(field.item),
              ] as Value)
            }
          >
            Add {isMap ? 'entry' : 'item'}
          </button>
          {after}
        </fieldset>
      );
    }
    case 'tuple': {
      const items = value as Value[];
      return (
        <fieldset className="rounded border border-line p-2">
          <legend className="px-1 font-mono text-xs text-ink">{label}</legend>
          <div className="grid gap-2">
            {field.items.map((f, i) =>
              nested(`[${i}]`, `${label}.${i}`, f, items[i] ?? initialValue(f), (v) =>
                onChange(items.map((x, j) => (j === i ? v : x)) as Value)),
            )}
          </div>
          {after}
        </fieldset>
      );
    }
    case 'struct': {
      const v = value as Record<string, Value>;
      return (
        <fieldset className="rounded border border-line p-2">
          <legend className="px-1 font-mono text-xs text-ink">
            {label} <span className="font-sans text-faint">{field.name}</span>
          </legend>
          <div className="grid gap-2">
            {field.fields.map((f) =>
              nested(f.name, f.name, f.field, v[f.name] ?? initialValue(f.field), (x) => onChange({ ...v, [f.name]: x }), f.doc),
            )}
          </div>
          {after}
        </fieldset>
      );
    }
    case 'union': {
      const v = value as { tag: string; values: Value[] };
      const c = field.cases.find((x) => x.name === v.tag);
      return (
        <fieldset className="rounded border border-line p-2">
          <legend className="px-1 font-mono text-xs text-ink">
            {label} <span className="font-sans text-faint">{field.name}</span>
          </legend>
          <select
            id={id}
            aria-label={`${label} variant`}
            aria-describedby={describedBy}
            value={v.tag}
            onChange={(e) => {
              const next = field.cases.find((x) => x.name === e.target.value);
              onChange({ tag: e.target.value, values: (next?.fields ?? []).map(initialValue) });
            }}
            className={input}
          >
            {field.cases.map((x) => (
              <option key={x.name} value={x.name}>
                {x.name}
              </option>
            ))}
          </select>
          {c && c.fields.length > 0 && (
            <div className="mt-2 grid gap-2">
              {c.fields.map((f, i) =>
                nested(`${c.name}[${i}]`, `${c.name}.${i}`, f, v.values[i] ?? initialValue(f), (x) =>
                  onChange({ tag: v.tag, values: v.values.map((y, j) => (j === i ? x : y)) })),
              )}
            </div>
          )}
          {after}
        </fieldset>
      );
    }
    case 'enum':
      return (
        <div>
          {labelEl}
          <select
            id={id}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            value={value as string}
            onChange={(e) => onChange(e.target.value)}
            className={`${input} mt-1`}
          >
            <option value="">choose {field.name}</option>
            {field.variants.map((x) => (
              <option key={x.name} value={String(x.value)}>
                {x.name} ({x.value})
              </option>
            ))}
          </select>
          {after}
        </div>
      );
    default:
      return (
        <div>
          {labelEl}
          {field.kind === 'raw' ? (
            <textarea
              id={id}
              rows={2}
              aria-describedby={describedBy}
              aria-invalid={error ? true : undefined}
              value={value as string}
              onChange={(e) => onChange(e.target.value)}
              className={`${input} mt-1`}
            />
          ) : (
            <input
              id={id}
              type="text"
              inputMode={field.kind === 'int' || field.kind === 'bigint' ? 'numeric' : undefined}
              spellCheck={false}
              autoComplete="off"
              list={field.kind === 'address' && accounts.length ? 'fork-accounts' : undefined}
              aria-describedby={describedBy}
              aria-invalid={error ? true : undefined}
              value={value as string}
              onChange={(e) => onChange(e.target.value)}
              className={`${input} mt-1`}
            />
          )}
          {after}
        </div>
      );
  }
}
