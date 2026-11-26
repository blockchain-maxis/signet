import { useEffect, useMemo, useRef, useState } from 'react';
import type { SpecJson } from '@signet/spec';
import type { Api } from '../api.ts';
import type { CallRun } from './CallForm.tsx';

export function SaveReplayForm({
  api,
  run,
  spec,
}: {
  api: Api;
  run: CallRun;
  spec: SpecJson | null;
}) {
  const [name, setName] = useState(run.function);
  const [expectVal, setExpectVal] = useState('unchanged');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const confirmRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    setName(run.function);
    setExpectVal('unchanged');
    setStatus(null);
  }, [run.function, run.args]);

  useEffect(() => {
    if (status) {
      confirmRef.current?.focus();
    }
  }, [status]);

  const errorCases = useMemo(() => {
    const names = new Set<string>();
    for (const e of spec?.errors ?? []) {
      names.add(e.name);
    }
    return Array.from(names).map((n) => `error:${n}`);
  }, [spec]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setStatus(null);
    try {
      await api.post('calls', {
        name: name.trim() || run.function,
        function: run.function,
        args: run.args ?? {},
        expect: expectVal,
      });
      setStatus({ kind: 'success', message: 'Saved call to signet.dev.toml' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus({ kind: 'error', message: msg });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      aria-label="Save as a replay"
      onSubmit={handleSave}
      className="mt-3 grid content-start gap-2 rounded border border-line bg-raised/30 p-3"
    >
      <h4 className="font-mono text-xs font-semibold text-ink">Save as a replay</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1">
          <label htmlFor="save-replay-name" className="text-xs text-muted">
            Name
          </label>
          <input
            id="save-replay-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded border border-line bg-page px-2 py-1 font-mono text-xs text-ink focus:border-accent focus:outline-none"
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor="save-replay-expect" className="text-xs text-muted">
            Expect
          </label>
          <select
            id="save-replay-expect"
            value={expectVal}
            onChange={(e) => setExpectVal(e.target.value)}
            className="rounded border border-line bg-page px-2 py-1 font-mono text-xs text-ink focus:border-accent focus:outline-none"
          >
            <option value="unchanged">unchanged</option>
            <option value="ok">ok</option>
            <option value="any">any</option>
            {errorCases.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <button
          type="submit"
          disabled={saving}
          className="rounded border border-line px-3 py-1 text-xs text-ink hover:bg-raised active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save as a replay'}
        </button>
      </div>
      {status && (
        <p
          ref={confirmRef}
          tabIndex={-1}
          role={status.kind === 'error' ? 'alert' : 'status'}
          className={`rounded border p-2 text-xs outline-none ${
            status.kind === 'error' ? 'border-bad text-bad' : 'border-line text-ink'
          }`}
        >
          {status.message}
        </p>
      )}
    </form>
  );
}
