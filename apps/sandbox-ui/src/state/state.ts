/**
 * @file The state view's model (#583): the fork's entries as rows, and
 * overrides in the #559 storage-expression syntax.
 *
 * A storage expression is `Variant` or `Variant(arg, …)` (a contracttype
 * case, its arguments JSON), a typed value `type:JSON` (`u32:5`,
 * `address:"G…"`, or a spec type, `Profile:{"age":3}`), typed ScVal JSON, or
 * a JSON string or bool. The editor builds `type:JSON` from a typed form, so
 * a value is never written as XDR by hand.
 */

export type Layer = 'fork' | 'override' | 'session';

/** An entry as `GET /api/state?layer=fork` returns it, `decoded` from entries_describe. */
export interface ForkEntry {
  readonly key: string;
  readonly last_modified_ledger_seq?: number;
  readonly live_until_ledger_seq?: number | null;
  readonly provenance?: { readonly fetched_at_ledger?: number; readonly drifted?: boolean };
  readonly decoded?: {
    readonly kind: string;
    readonly contract?: string;
    readonly durability?: string;
    readonly key?: unknown;
    readonly value?: unknown;
    readonly executable?: string;
    readonly storage?: readonly { key: unknown; value: unknown }[];
    readonly hash?: string;
    readonly bytes?: number;
  };
}

export interface Override {
  readonly id: string;
  readonly durability: string;
  readonly key: string;
  readonly value?: string;
  readonly unset?: boolean;
}

export interface Row {
  /** What the row is, in words: `persistent Owner("alice")`, `instance count`. */
  readonly label: string;
  readonly durability: string | null;
  readonly value: string;
  readonly liveUntil: number | null;
  readonly drifted: boolean;
  /** The #559 key expression, for "override this", when it can be written. */
  readonly keyExpression: string | null;
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/**
 * A decoded key as a storage expression: a contracttype case
 * `["Owner","alice"]` as `Owner("alice")`, a symbol as `symbol:"name"`.
 */
export function keyExpression(key: unknown): string | null {
  if (typeof key === 'string') return `symbol:${JSON.stringify(key)}`;
  if (Array.isArray(key) && typeof key[0] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key[0])) {
    const [name, ...args] = key;
    return args.length ? `${name}(${args.map((a) => JSON.stringify(a)).join(', ')})` : name;
  }
  return null;
}

/** The fork's entries as rows; an instance's storage map is a row per key. */
export function forkRows(entries: readonly ForkEntry[]): Row[] {
  const rows: Row[] = [];
  for (const e of entries) {
    const d = e.decoded;
    const liveUntil = e.live_until_ledger_seq ?? null;
    const drifted = e.provenance?.drifted === true;
    if (d?.kind === 'instance') {
      rows.push({ label: `instance (${d.executable ?? 'executable'})`, durability: 'instance', value: `${d.storage?.length ?? 0} keys`, liveUntil, drifted, keyExpression: null });
      for (const item of d.storage ?? []) {
        const expr = keyExpression(item.key);
        rows.push({ label: `instance ${expr ?? show(item.key)}`, durability: 'instance', value: show(item.value), liveUntil, drifted, keyExpression: expr });
      }
    } else if (d?.kind === 'contract_data') {
      const expr = keyExpression(d.key);
      rows.push({ label: `${d.durability} ${expr ?? show(d.key)}`, durability: d.durability ?? null, value: show(d.value), liveUntil, drifted, keyExpression: expr });
    } else if (d?.kind === 'contract_code') {
      rows.push({ label: `code ${d.hash?.slice(0, 8) ?? ''}…`, durability: null, value: `${d.bytes ?? 0} bytes`, liveUntil, drifted, keyExpression: null });
    } else {
      rows.push({ label: d?.kind ?? 'entry', durability: null, value: '', liveUntil, drifted, keyExpression: null });
    }
  }
  return rows;
}

/** A TTL against the fork's ledger: `live, 719 ledgers left`, or archived. */
export function ttlLabel(liveUntil: number | null, ledger: number): { text: string; archived: boolean } {
  if (liveUntil === null) return { text: 'no TTL', archived: false };
  if (liveUntil < ledger) return { text: `archived (live until ${liveUntil})`, archived: true };
  return { text: `live until ${liveUntil}, ${liveUntil - ledger} ledgers left`, archived: false };
}

/** What the fork holds: every entry (a snapshot import), or only keys something read (#554). */
export function completeness(consistent: boolean, ledger: number): string {
  return consistent
    ? `Complete: every entry of the contract at ledger ${ledger}.`
    : 'Not the full storage: a lazy fork holds only the keys something has read so far.';
}

/** A typed value as a storage expression: `u32:5`, `address:"G…"`, `Profile:{…}`. */
export function typedExpression(type: string, json: unknown): string {
  return `${type}:${JSON.stringify(json)}`;
}

/** Overrides the UI added (and can delete), as against those from signet.dev.toml. */
export const isUiOverride = (o: Override) => o.id.startsWith('ui-');
