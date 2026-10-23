/**
 * @file packages/spec/src/storage/shape.ts
 *
 * Observed ledger keys grouped into storage "slots" by shape (#513).
 *
 * Soroban has no declared storage schema (CONTRACT_VISUALISER_DESIGN.md
 * §1.3), but footprints show which keys a contract actually touches. Most
 * contracts key storage with a `#[contracttype]` `DataKey` union, which the
 * SDK encodes as `Vec[Symbol(case), ...fields]`, so a key like
 * `Vec[Symbol("Balance"), Address(G…)]` has the shape `Balance(Address)`.
 * Replacing the concrete values with their type names turns a pile of keys
 * into a short list of slots; when the union is in the spec (it often is),
 * the case name and arity identify the spec type too.
 *
 * Shape rules:
 * - a symbol is kept verbatim;
 * - a vector led by a symbol is a union case: `Case(field, …)`;
 * - any other vector is a tuple: `(a, b)`;
 * - a map with all-symbol keys is a struct: `{name: Type, …}`; any other map is `Map`;
 * - every other value is replaced by its type name (`Address`, `U32`, `Bytes`, …).
 *
 * Pure: XDR in, plain data out. Shapes are labels for a reader, not a
 * schema — they are _observed_, never declared.
 */

import { xdr } from '@stellar/stellar-sdk';
import type { FootprintObservation, LedgerKeyRef } from '../observe/types.ts';
import type { ContractSpec } from '../types.ts';

/** The shape of one storage key, and the spec type it matched, if any. */
export interface KeyShape {
  readonly shape: string;
  /** The spec union or enum whose case name and arity fit the key. */
  readonly specType?: string;
}

/** Type names for the ScVal arms that are replaced by their type. */
const VALUE_TYPE_NAMES: Record<string, string> = {
  scvBool: 'Bool',
  scvVoid: 'Void',
  scvError: 'Error',
  scvU32: 'U32',
  scvI32: 'I32',
  scvU64: 'U64',
  scvI64: 'I64',
  scvTimepoint: 'Timepoint',
  scvDuration: 'Duration',
  scvU128: 'U128',
  scvI128: 'I128',
  scvU256: 'U256',
  scvI256: 'I256',
  scvBytes: 'Bytes',
  scvString: 'String',
  scvAddress: 'Address',
  scvContractInstance: 'ContractInstance',
  scvLedgerKeyContractInstance: 'Instance',
  scvLedgerKeyNonce: 'Nonce',
};

function renderShape(val: xdr.ScVal): string {
  const arm = val.switch().name;
  switch (arm) {
    case 'scvSymbol':
      return val.sym().toString();
    case 'scvVec': {
      const items = val.vec() ?? [];
      const head = items[0];
      if (head && head.switch().name === 'scvSymbol') {
        const fields = items.slice(1).map(renderShape);
        return fields.length ? `${head.sym().toString()}(${fields.join(', ')})` : head.sym().toString();
      }
      return `(${items.map(renderShape).join(', ')})`;
    }
    case 'scvMap': {
      const entries = val.map() ?? [];
      if (entries.length && entries.every((e) => e.key().switch().name === 'scvSymbol')) {
        return `{${entries.map((e) => `${e.key().sym().toString()}: ${renderShape(e.val())}`).join(', ')}}`;
      }
      return 'Map';
    }
    default:
      return VALUE_TYPE_NAMES[arm] ?? arm.replace(/^scv/, '');
  }
}

/** The case name and arity a key encodes, when it looks like a union/enum case. */
function caseOf(val: xdr.ScVal): { name: string; arity: number } | null {
  switch (val.switch().name) {
    case 'scvSymbol':
      return { name: val.sym().toString(), arity: 0 };
    case 'scvVec': {
      const items = val.vec() ?? [];
      const head = items[0];
      if (head && head.switch().name === 'scvSymbol') {
        return { name: head.sym().toString(), arity: items.length - 1 };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Match a case against the spec: the first union (in spec order) with a case
 * of that name and arity, else — for a field-less case — the first enum with
 * a variant of that name.
 */
function matchSpecType(spec: ContractSpec | undefined, kase: { name: string; arity: number }): string | undefined {
  if (!spec) return undefined;
  for (const type of spec.types) {
    if (type.kind === 'union' && type.cases.some((c) => c.name === kase.name && c.fields.length === kase.arity)) {
      return type.name;
    }
  }
  if (kase.arity === 0) {
    for (const type of spec.types) {
      if (type.kind === 'enum' && type.variants.some((v) => v.name === kase.name)) return type.name;
    }
  }
  return undefined;
}

/** The shape of a storage key, matched against the spec's unions and enums. */
export function keyShape(scVal: xdr.ScVal, spec?: ContractSpec): KeyShape {
  const shape = renderShape(scVal);
  const kase = caseOf(scVal);
  const specType = kase ? matchSpecType(spec, kase) : undefined;
  return specType ? { shape, specType } : { shape };
}

/** Where a slot lives: the instance entry, or a persistent/temporary data entry. */
export type StorageDurability = 'instance' | 'persistent' | 'temporary';

/** One storage slot: every observed key of one shape and durability. */
export interface StorageSlot {
  readonly durability: StorageDurability;
  readonly shape: string;
  readonly specType?: string;
  /** How many distinct concrete keys of this shape were observed. */
  readonly distinctKeys: number;
  /** Functions that accessed a key of this slot without changing it, sorted. */
  readonly readBy: readonly string[];
  /** Functions that changed a key of this slot, sorted. */
  readonly writtenBy: readonly string[];
  readonly firstSeenLedger: number;
  readonly lastSeenLedger: number;
}

const DURABILITY_ORDER: Record<StorageDurability, number> = { instance: 0, persistent: 1, temporary: 2 };

interface DecodedKey {
  readonly durability: StorageDurability;
  readonly key: xdr.ScVal;
}

function decodeOwnKey(ref: LedgerKeyRef): DecodedKey | null {
  if (ref.kind !== 'own-data' && ref.kind !== 'own-instance') return null;
  try {
    const data = xdr.LedgerKey.fromXDR(ref.raw, 'base64').contractData();
    if (ref.kind === 'own-instance') return { durability: 'instance', key: data.key() };
    const durability = data.durability().name === 'temporary' ? 'temporary' : 'persistent';
    return { durability, key: data.key() };
  } catch {
    return null;
  }
}

/**
 * Group a contract's observed footprint keys into storage slots, using only
 * its own data and instance keys (#509's `own-data`/`own-instance`).
 *
 * Write evidence is the meta-reported `changed` set when the observation has
 * one, else the declared `readWrite`; a key accessed but not changed counts
 * as a read. Observations of other contracts are ignored, and an observation
 * whose function is unknown still counts towards keys and ledgers but names
 * no reader or writer.
 */
export function groupLedgerKeys(
  observations: readonly FootprintObservation[],
  contract: string,
  spec?: ContractSpec,
): StorageSlot[] {
  interface Acc {
    durability: StorageDurability;
    shape: string;
    specType?: string;
    keys: Set<string>;
    readBy: Set<string>;
    writtenBy: Set<string>;
    firstSeenLedger: number;
    lastSeenLedger: number;
  }
  const slots = new Map<string, Acc>();

  for (const obs of observations) {
    if (obs.contract !== contract) continue;
    const written = new Set((obs.changed ?? obs.readWrite).map((ref) => ref.raw));
    const seen = new Map<string, LedgerKeyRef>();
    for (const ref of [...obs.readOnly, ...obs.readWrite, ...(obs.changed ?? [])]) seen.set(ref.raw, ref);

    for (const [raw, ref] of seen) {
      const decoded = decodeOwnKey(ref);
      if (!decoded) continue;
      const { shape, specType } = keyShape(decoded.key, spec);
      const id = `${decoded.durability}\u0000${shape}`;
      let acc = slots.get(id);
      if (!acc) {
        acc = {
          durability: decoded.durability,
          shape,
          ...(specType && { specType }),
          keys: new Set(),
          readBy: new Set(),
          writtenBy: new Set(),
          firstSeenLedger: obs.ledger,
          lastSeenLedger: obs.ledger,
        };
        slots.set(id, acc);
      }
      acc.keys.add(raw);
      acc.firstSeenLedger = Math.min(acc.firstSeenLedger, obs.ledger);
      acc.lastSeenLedger = Math.max(acc.lastSeenLedger, obs.ledger);
      if (obs.function) (written.has(raw) ? acc.writtenBy : acc.readBy).add(obs.function);
    }
  }

  return [...slots.values()]
    .map(({ keys, readBy, writtenBy, ...acc }) => ({
      ...acc,
      distinctKeys: keys.size,
      readBy: [...readBy].sort(),
      writtenBy: [...writtenBy].sort(),
    }))
    .sort(
      (a, b) =>
        DURABILITY_ORDER[a.durability] - DURABILITY_ORDER[b.durability] ||
        (a.shape < b.shape ? -1 : a.shape > b.shape ? 1 : 0),
    );
}
