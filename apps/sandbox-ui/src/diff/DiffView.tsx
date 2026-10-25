import { useEffect, useRef, useState } from 'react';

/** A difference's class (#569). */
export type DiffClass = 'breaking' | 'behavioural' | 'cost' | 'ignored';

interface Tagged {
  readonly type?: string;
  readonly value?: unknown;
}

export interface CycleDiff {
  readonly summary: Record<DiffClass, number>;
  readonly outcome?: { a: string; b: string; class: DiffClass } | null;
  readonly return_value?: { path: string; a: Tagged | null; b: Tagged | null; class: DiffClass } | null;
  readonly events?: Record<'added' | 'removed' | 'changed', { index: number; topics?: unknown[]; path?: string; a?: unknown; b?: unknown; event?: unknown; class: DiffClass }[]>;
  readonly storage?: Record<'added' | 'removed' | 'changed' | 'ttl', { key: string; path?: string; a?: unknown; b?: unknown; entry?: unknown; class: DiffClass }[]>;
  readonly auth?: {
    client_breaking: boolean;
    added: { signer: string; class: DiffClass }[];
    removed: { signer: string; class: DiffClass }[];
    changed: { signer: string; path?: string; a?: unknown; b?: unknown; class: DiffClass }[];
  };
  readonly resources?: { metric: string; a: number; b: number; delta: number; percent: number | null; class: DiffClass }[];
}

export interface DiffOutcome {
  readonly name: string;
  readonly diff?: CycleDiff | null;
  readonly verdict?: { expect: string; pass: boolean; reason?: string };
}

export interface DiffCycle {
  readonly id: number;
  readonly deployed: string;
  readonly local: string;
  readonly outcomes: readonly DiffOutcome[];
  readonly spec?: {
    compatible: boolean;
    summary: { breaking: number; compatible: number; info: number };
    changes: { kind: string; path: string; class: string; reason: string; rule?: string; storage_note?: string }[];
  } | null;
  readonly layout?: {
    compatible: boolean;
    checked: number;
    findings: { key: string; decoded_key?: unknown; udt: string; reason: string; evidence: 'static' | 'replay' | string }[];
  } | null;
}

const CLASSES: readonly DiffClass[] = ['breaking', 'behavioural', 'cost', 'ignored'];

/** A class in text and a glyph as well as colour, so it reads without hue. */
const CLASS_MARK: Record<string, { glyph: string; label: string; tone: string }> = {
  breaking: { glyph: '✕', label: 'breaking', tone: 'border-bad text-bad' },
  behavioural: { glyph: '!', label: 'behavioural', tone: 'border-accent text-accent' },
  cost: { glyph: '~', label: 'cost', tone: 'border-line text-ink' },
  ignored: { glyph: '·', label: 'ignored', tone: 'border-line text-faint' },
  compatible: { glyph: '✓', label: 'compatible', tone: 'border-line text-ok' },
  info: { glyph: 'i', label: 'info', tone: 'border-line text-muted' },
};

export function ClassBadge({ value }: { value: string }) {
  const m = CLASS_MARK[value] ?? { glyph: '?', label: value, tone: 'border-line text-muted' };
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1 font-mono text-xs ${m.tone}`}>
      <span aria-hidden="true">{m.glyph}</span>
      {m.label}
    </span>
  );
}

const show = (v: unknown) => (v === undefined || v === null ? 'nothing' : JSON.stringify(v));
const tagged = (v: Tagged | null) => (v ? `${v.type ?? ''} ${show(v.value)}`.trim() : 'nothing');

/** What an item amounts to, worst class first: `2 breaking, 4 cost`, or `same`. */
export function summaryText(diff: CycleDiff | null | undefined): string {
  if (!diff) return 'not compared';
  const parts = CLASSES.filter((c) => c !== 'ignored' && diff.summary[c]).map((c) => `${diff.summary[c]} ${c}`);
  return parts.length ? parts.join(', ') : 'same';
}

function worst(diff: CycleDiff | null | undefined): DiffClass | null {
  return diff ? (CLASSES.find((c) => c !== 'ignored' && diff.summary[c] > 0) ?? null) : null;
}

function Side({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-faint">{label}</div>
      <div className="break-all font-mono text-ink">{children}</div>
    </div>
  );
}

function Detail({ outcome }: { outcome: DiffOutcome }) {
  const d = outcome.diff;
  if (!d) return <p className="text-sm text-muted">This call was not compared.</p>;
  const events = d.events ? [...d.events.added.map((e) => ({ ...e, how: 'added' })), ...d.events.removed.map((e) => ({ ...e, how: 'removed' })), ...d.events.changed.map((e) => ({ ...e, how: 'changed' }))] : [];
  const writes = d.storage ? [...d.storage.added.map((w) => ({ ...w, how: 'added' })), ...d.storage.removed.map((w) => ({ ...w, how: 'removed' })), ...d.storage.changed.map((w) => ({ ...w, how: 'changed' })), ...d.storage.ttl.map((w) => ({ ...w, how: 'TTL' }))] : [];
  const maxResource = Math.max(1, ...(d.resources ?? []).flatMap((r) => [r.a, r.b]));
  return (
    <div className="grid gap-4 text-xs">
      {d.outcome && (
        <section aria-label="Outcome">
          <h4 className="flex items-center gap-2 text-muted">Outcome <ClassBadge value={d.outcome.class} /></h4>
          <div className="mt-1 grid grid-cols-2 gap-3">
            <Side label="Deployed (A)">{d.outcome.a}</Side>
            <Side label="Build (B)">{d.outcome.b}</Side>
          </div>
        </section>
      )}
      {d.return_value && (
        <section aria-label="Return value">
          <h4 className="flex items-center gap-2 text-muted">
            Return value <ClassBadge value={d.return_value.class} />
            <span className="font-mono text-faint">at <mark className="bg-raised px-1 text-ink">{d.return_value.path || '/'}</mark></span>
          </h4>
          <div className="mt-1 grid grid-cols-2 gap-3">
            <Side label="Deployed (A)">{tagged(d.return_value.a)}</Side>
            <Side label="Build (B)">{tagged(d.return_value.b)}</Side>
          </div>
        </section>
      )}
      {events.length > 0 && (
        <section aria-label="Events">
          <h4 className="text-muted">Events</h4>
          <ul className="mt-1 grid gap-1">
            {events.map((e, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <ClassBadge value={e.class} />
                <span className="font-mono">#{e.index} {e.how}{e.path ? ` at ${e.path}` : ''}</span>
                {e.how === 'changed' && <span className="font-mono text-muted">{show(e.a)} → {show(e.b)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {writes.length > 0 && (
        <section aria-label="Storage writes">
          <table className="w-full border-collapse text-left">
            <caption className="text-left text-muted">Storage writes</caption>
            <thead className="text-faint">
              <tr className="border-b border-line">
                <th scope="col" className="py-1 pr-3 font-medium">Key</th>
                <th scope="col" className="py-1 pr-3 font-medium">Deployed (A) after</th>
                <th scope="col" className="py-1 pr-3 font-medium">Build (B) after</th>
                <th scope="col" className="py-1 font-medium">Class</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {writes.map((w, i) => (
                <tr key={i} className="border-b border-line align-top">
                  <td className="break-all py-1 pr-3">{w.key}{w.path ? ` ${w.path}` : ''} <span className="font-sans text-faint">({w.how})</span></td>
                  <td className="break-all py-1 pr-3">{w.how === 'added' ? 'nothing' : show(w.a ?? w.entry)}</td>
                  <td className="break-all py-1 pr-3">{w.how === 'removed' ? 'nothing' : show(w.b ?? w.entry)}</td>
                  <td className="py-1"><ClassBadge value={w.class} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {d.auth && (d.auth.added.length > 0 || d.auth.removed.length > 0 || d.auth.changed.length > 0) && (
        <section aria-label="Auth">
          <h4 className="flex items-center gap-2 text-muted">
            Auth {d.auth.client_breaking && <span className="rounded border border-bad px-1 text-bad">client-breaking: wallets must sign differently</span>}
          </h4>
          <ul className="mt-1 grid gap-1 font-mono">
            {d.auth.added.map((a) => (
              <li key={`+${a.signer}`}><span className="text-bad">+ signer</span> {a.signer} <span className="font-sans text-faint">(the build asks for it)</span></li>
            ))}
            {d.auth.removed.map((a) => (
              <li key={`-${a.signer}`}><span className="text-bad">− signer</span> {a.signer} <span className="font-sans text-faint">(the build no longer asks for it)</span></li>
            ))}
            {d.auth.changed.map((a) => (
              <li key={`~${a.signer}`}><span className="text-bad">~ signer</span> {a.signer} at {a.path}: {show(a.a)} → {show(a.b)}</li>
            ))}
          </ul>
        </section>
      )}
      {(d.resources?.length ?? 0) > 0 && (
        <section aria-label="Resources">
          <h4 className="text-muted">Resources</h4>
          <ul className="mt-1 grid gap-2">
            {d.resources!.map((r) => (
              <li key={r.metric} className="grid gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-ink">{r.metric}</span>
                  <span className="font-mono text-muted">
                    {r.a.toLocaleString('en-US')} → {r.b.toLocaleString('en-US')} ({r.delta >= 0 ? '+' : ''}{r.percent === null ? r.delta.toLocaleString('en-US') : `${r.percent}%`})
                  </span>
                  <ClassBadge value={r.class} />
                  {r.class === 'ignored' && <span className="text-faint">within the tolerance</span>}
                </div>
                {(['a', 'b'] as const).map((side) => (
                  <div key={side} className="flex items-center gap-2" aria-hidden="true">
                    <span className="w-3 font-mono text-faint">{side.toUpperCase()}</span>
                    <span className="block h-1.5 rounded bg-raised" style={{ width: `${Math.max(1, (r[side] / maxResource) * 100)}%` }}>
                      <span className={`block h-full rounded ${side === 'b' ? 'bg-accent' : 'bg-faint'}`} />
                    </span>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
      {outcome.verdict && (
        <p className={outcome.verdict.pass ? 'text-ok' : 'text-bad'}>
          expect {outcome.verdict.expect}: {outcome.verdict.pass ? 'held' : `failed${outcome.verdict.reason ? `, ${outcome.verdict.reason}` : ''}`}
        </p>
      )}
    </div>
  );
}

/**
 * The A/B diff view (#584): the cycle's calls, each summarised by class,
 * and the selected one side by side; the spec and layout findings next to
 * them. Up and Down move between calls.
 */
export function DiffView({ cycle }: { cycle: DiffCycle }) {
  const [selected, setSelected] = useState(0);
  const items = useRef<(HTMLLIElement | null)[]>([]);
  const outcome = cycle.outcomes[selected] ?? cycle.outcomes[0];
  useEffect(() => {
    if (selected >= cycle.outcomes.length) setSelected(0);
  }, [cycle, selected]);

  const totals = Object.fromEntries(CLASSES.map((c) => [c, cycle.outcomes.reduce((n, o) => n + (o.diff?.summary[c] ?? 0), 0)])) as Record<DiffClass, number>;

  function onKey(e: React.KeyboardEvent) {
    const next = e.key === 'ArrowDown' ? selected + 1 : e.key === 'ArrowUp' ? selected - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? cycle.outcomes.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const clamped = Math.max(0, Math.min(cycle.outcomes.length - 1, next));
    setSelected(clamped);
    items.current[clamped]?.focus();
  }

  return (
    <div className="mt-3 grid gap-4">
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted" aria-label="Cycle summary">
        {CLASSES.map((c) => (
          <span key={c} className="flex items-center gap-1"><ClassBadge value={c} /> {totals[c]}</span>
        ))}
      </p>
      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <ul role="listbox" aria-label="Calls in this cycle" onKeyDown={onKey} className="grid content-start gap-1">
          {cycle.outcomes.map((o, i) => {
            const w = worst(o.diff);
            return (
              <li
                key={o.name}
                ref={(el) => {
                  items.current[i] = el;
                }}
                role="option"
                aria-selected={i === selected}
                tabIndex={i === selected ? 0 : -1}
                onClick={() => setSelected(i)}
                className={`cursor-pointer rounded border px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${i === selected ? 'border-accent bg-raised' : 'border-line hover:bg-raised'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-ink">{o.name}</span>
                  {w && <ClassBadge value={w} />}
                </div>
                <div className="text-faint">{summaryText(o.diff)}</div>
              </li>
            );
          })}
        </ul>
        <section aria-label={`Differences in ${outcome?.name ?? ''}`} className="min-w-0 rounded border border-line p-3">
          {outcome ? <Detail outcome={outcome} /> : <p className="text-sm text-muted">This cycle replayed no calls.</p>}
        </section>
      </div>

      {cycle.spec && cycle.spec.changes.length > 0 && (
        <section aria-label="Spec findings" className="rounded border border-line p-3 text-xs">
          <h3 className="text-sm font-semibold">Interface changes</h3>
          <ul className="mt-2 grid gap-2">
            {cycle.spec.changes.map((c, i) => (
              <li key={i} className="grid gap-0.5">
                <div className="flex flex-wrap items-center gap-2"><ClassBadge value={c.class} /><span className="font-mono text-ink">{c.path}</span><span className="text-faint">{c.kind}</span></div>
                <p className="text-muted">{c.reason}{c.rule ? ` (${c.rule})` : ''}</p>
                {c.storage_note && <p className="text-muted">{c.storage_note}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {cycle.layout && cycle.layout.findings.length > 0 && (
        <section aria-label="Layout findings" className="rounded border border-line p-3 text-xs">
          <h3 className="text-sm font-semibold">Stored values the build cannot read</h3>
          <ul className="mt-2 grid gap-2">
            {cycle.layout.findings.map((f, i) => (
              <li key={i} className="grid gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <ClassBadge value="breaking" />
                  <span className="rounded border border-line px-1 text-muted">{f.evidence === 'replay' ? 'replay: a call failed reading it' : 'static: the specs say so'}</span>
                  <span className="font-mono text-ink">{f.udt} at {show(f.decoded_key ?? f.key)}</span>
                </div>
                <p className="text-muted">{f.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
