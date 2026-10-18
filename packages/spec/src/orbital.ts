/**
 * @file @signet/spec — Orbital ABI compatibility export (B-16, issue #439).
 *
 * Provides local copies of Orbital's ABI types and an export function that
 * translates Signet's decoded `ContractSpec` / `SpecJson` into Orbital's
 * canonical `ContractSpec` representation.
 *
 * Upstream definition:
 * https://github.com/determined-001/orbital_stellar/blob/main/packages/abi-registry/src/spec.ts
 *
 * Licensed under the MIT License:
 * Copyright (c) 2026 Orbital Contributors
 */

import type {
  ContractSpec,
  SpecErrorCase,
  SpecEvent,
  SpecFunction,
  TypeRef,
} from './types.ts';
import type { SpecJson } from './json.ts';

// ── Orbital Type System (vendored types) ──────────────────────────────────────

/** All atomic Soroban scalar types recognised by Orbital. */
export type OrbitalPrimitiveType =
  | 'bool'
  | 'u32'
  | 'i32'
  | 'u64'
  | 'i64'
  | 'u128'
  | 'i128'
  | 'u256'
  | 'i256'
  | 'bytes'
  | 'string'
  | 'symbol'
  | 'address'
  | 'void'
  | 'error';

/** Fixed-length byte array, e.g. `bytes_n<32>`. */
export interface OrbitalBytesNType {
  readonly type: 'bytes_n';
  readonly size: number;
}

/** Soroban `Option<T>` - a value that may be present or absent. */
export interface OrbitalOptionType {
  readonly type: 'option';
  readonly inner: OrbitalTypeSpec;
}

/** Soroban `Result<T, E>` - either an `Ok` value or an `Err` value. */
export interface OrbitalResultType {
  readonly type: 'result';
  readonly ok: OrbitalTypeSpec;
  readonly err: OrbitalTypeSpec;
}

/** Homogeneous variable-length sequence. */
export interface OrbitalVecType {
  readonly type: 'vec';
  readonly item: OrbitalTypeSpec;
}

/** Ordered key-value map. */
export interface OrbitalMapType {
  readonly type: 'map';
  readonly key: OrbitalTypeSpec;
  readonly value: OrbitalTypeSpec;
}

/** Fixed-length heterogeneous sequence (Soroban `Tuple`). Minimum 2 elements. */
export interface OrbitalTupleType {
  readonly type: 'tuple';
  readonly elements: readonly OrbitalTypeSpec[];
}

/** Reference to a user-defined type declared in `ContractSpec.types`. */
export interface OrbitalNamedType {
  readonly type: 'named';
  readonly name: string;
}

/**
 * Union of every representable Soroban type in Orbital.
 */
export type OrbitalTypeSpec =
  | OrbitalPrimitiveType
  | OrbitalBytesNType
  | OrbitalOptionType
  | OrbitalResultType
  | OrbitalVecType
  | OrbitalMapType
  | OrbitalTupleType
  | OrbitalNamedType;

/** A named, typed field used in function params, struct fields, and event data. */
export interface OrbitalFieldSpec {
  readonly name: string;
  readonly type: OrbitalTypeSpec;
  readonly doc?: string;
}

/** Specification of one exported Soroban contract function in Orbital. */
export interface OrbitalFunctionSpec {
  readonly name: string;
  readonly doc?: string;
  readonly params: readonly OrbitalFieldSpec[];
  readonly returns: OrbitalTypeSpec;
}

/** Specification of one contract event in Orbital. */
export interface OrbitalEventSpec {
  readonly name: string;
  readonly doc?: string;
  readonly topics: readonly OrbitalFieldSpec[];
  readonly data: readonly OrbitalFieldSpec[];
}

/** Descriptor for a user-defined struct type in Orbital. */
export interface OrbitalStructTypeSpec {
  readonly kind: 'struct';
  readonly name: string;
  readonly doc?: string;
  readonly fields: readonly OrbitalFieldSpec[];
}

/** A single variant of an enum in Orbital. */
export interface OrbitalEnumVariantSpec {
  readonly name: string;
  readonly doc?: string;
  readonly discriminant: number;
  readonly value?: OrbitalTypeSpec;
}

/** Descriptor for a user-defined enum in Orbital. */
export interface OrbitalEnumTypeSpec {
  readonly kind: 'enum';
  readonly name: string;
  readonly doc?: string;
  readonly variants: readonly OrbitalEnumVariantSpec[];
}

/** A single case of a discriminated union in Orbital. */
export interface OrbitalUnionCaseSpec {
  readonly name: string;
  readonly doc?: string;
  readonly fields: readonly OrbitalFieldSpec[];
}

/** Descriptor for a user-defined discriminated union in Orbital. */
export interface OrbitalUnionTypeSpec {
  readonly kind: 'union';
  readonly name: string;
  readonly doc?: string;
  readonly cases: readonly OrbitalUnionCaseSpec[];
}

/** Any user-defined type that may appear in Orbital's `ContractSpec.types`. */
export type OrbitalUserDefinedType =
  | OrbitalStructTypeSpec
  | OrbitalEnumTypeSpec
  | OrbitalUnionTypeSpec;

/**
 * Canonical ABI specification for a deployed Soroban smart contract according
 * to Orbital's schema (`schema/spec.schema.json`).
 */
export interface OrbitalContractSpec {
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  readonly contractId?: string;
  readonly network?: 'mainnet' | 'testnet' | 'futurenet';
  readonly functions: readonly OrbitalFunctionSpec[];
  readonly events: readonly OrbitalEventSpec[];
  readonly types: Readonly<Record<string, OrbitalUserDefinedType>>;
  readonly xdrEntries?: readonly string[];
}

// ── Error definitions ─────────────────────────────────────────────────────────

/**
 * Thrown when a Signet specification contains constructs that cannot be
 * faithfully represented in the Orbital ABI specification format (e.g. unknown
 * XDR type arms).
 */
export class NotRepresentable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotRepresentable';
  }
}

// ── Type mapping ──────────────────────────────────────────────────────────────

/**
 * Maps Signet's atomic primitive types onto Orbital's `OrbitalPrimitiveType`.
 *
 * Signet extensions (#425) are mapped to their closest Orbital equivalent:
 *  - `timepoint`: mapped to `'u64'` (Soroban timepoints are 64-bit ledger timestamps)
 *  - `duration`: mapped to `'u64'` (Soroban durations are 64-bit relative second spans)
 *  - `muxedAddress`: mapped to `'address'` (a muxed account address on the wire)
 *  - `val`: mapped to `'u64'` (raw 64-bit host value representation)
 */
export const PRIMITIVE_MAPPINGS: Readonly<Record<string, OrbitalPrimitiveType>> = {
  bool: 'bool',
  u32: 'u32',
  i32: 'i32',
  u64: 'u64',
  i64: 'i64',
  u128: 'u128',
  i128: 'i128',
  u256: 'u256',
  i256: 'i256',
  bytes: 'bytes',
  string: 'string',
  symbol: 'symbol',
  address: 'address',
  void: 'void',
  error: 'error',
  // Signet extensions:
  timepoint: 'u64',
  duration: 'u64',
  muxedAddress: 'address',
  val: 'u64',
};

/**
 * Converts a Signet `TypeRef` into an `OrbitalTypeSpec`.
 *
 * Throws `NotRepresentable` if an unrecognised / unknown type arm is encountered.
 */
export function toOrbitalTypeSpec(type: TypeRef): OrbitalTypeSpec {
  if (typeof type === 'string') {
    const mapped = PRIMITIVE_MAPPINGS[type];
    if (mapped) return mapped;
    throw new NotRepresentable(`Primitive type '${type}' has no Orbital mapping`);
  }

  switch (type.type) {
    case 'bytes_n':
      return { type: 'bytes_n', size: type.n };
    case 'option':
      return { type: 'option', inner: toOrbitalTypeSpec(type.value) };
    case 'result':
      return {
        type: 'result',
        ok: toOrbitalTypeSpec(type.ok),
        err: toOrbitalTypeSpec(type.error),
      };
    case 'vec':
      return { type: 'vec', item: toOrbitalTypeSpec(type.element) };
    case 'map':
      return {
        type: 'map',
        key: toOrbitalTypeSpec(type.key),
        value: toOrbitalTypeSpec(type.value),
      };
    case 'tuple':
      return {
        type: 'tuple',
        elements: type.elements.map(toOrbitalTypeSpec),
      };
    case 'named':
      return { type: 'named', name: type.name };
    case 'unknown':
      throw new NotRepresentable(
        `Unknown XDR arm '${type.xdrArm}' cannot be represented in Orbital spec`,
      );
    default: {
      const exhaustiveCheck: never = type;
      throw new NotRepresentable(`Unsupported type: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Orbital's schema requires field names to match `^[a-zA-Z_][a-zA-Z0-9_]*$`.
 * Synthetic tuple names from Signet (`"0"`, `"1"`) are prefixed with `_` to
 * produce valid identifiers (`"_0"`, `"_1"`), matching Orbital's generator.
 */
function toOrbitalFieldName(name: string): string {
  if (/^[0-9]/.test(name)) {
    return `_${name}`;
  }
  return name;
}

// ── Export options and main converter ─────────────────────────────────────────

export interface ToOrbitalSpecOptions {
  /** Human-readable contract name (1-100 characters). */
  readonly name: string;
  /** Semantic version string, e.g. "1.0.0". */
  readonly version: string;
  /** Bech32-encoded Soroban contract address (`C...`). */
  readonly contractId?: string;
  /** Network name where contract is deployed. */
  readonly network?: 'mainnet' | 'testnet' | 'futurenet';
  /** Optional contract description (up to 500 characters). */
  readonly description?: string;
}

/**
 * Exports a Signet `ContractSpec` or `SpecJson` into an Orbital-compatible
 * `OrbitalContractSpec`.
 *
 * Validatable against `schema/vendor/orbital-spec.schema.json`.
 */
export function toOrbitalSpec(
  spec: ContractSpec | SpecJson,
  options: ToOrbitalSpecOptions,
): OrbitalContractSpec {
  // Functions
  const functions: OrbitalFunctionSpec[] = spec.functions.map((fn) => {
    let returns: OrbitalTypeSpec;
    if (fn.outputs.length === 0) {
      returns = 'void';
    } else if (fn.outputs.length === 1) {
      returns = toOrbitalTypeSpec(fn.outputs[0]!);
    } else {
      returns = {
        type: 'tuple',
        elements: fn.outputs.map(toOrbitalTypeSpec),
      };
    }

    return {
      name: fn.name,
      ...(fn.doc ? { doc: fn.doc } : {}),
      params: fn.inputs.map((input) => ({
        name: toOrbitalFieldName(input.name),
        type: toOrbitalTypeSpec(input.type),
        ...(input.doc ? { doc: input.doc } : {}),
      })),
      returns,
    };
  });

  // Events
  const events: OrbitalEventSpec[] = spec.events.map((ev) => {
    const prefixTopicFields: OrbitalFieldSpec[] = ev.prefixTopics.map((raw, i) => ({
      name: i === 0 ? 'event_name' : `prefix_topic_${i}`,
      type: 'symbol',
      doc: `Fixed prefix topic, always "${raw}".`,
    }));

    const topicParams: OrbitalFieldSpec[] = ev.params
      .filter((p) => p.location === 'topic')
      .map((p) => ({
        name: toOrbitalFieldName(p.name),
        type: toOrbitalTypeSpec(p.type),
      }));

    const dataParams: OrbitalFieldSpec[] = ev.params
      .filter((p) => p.location === 'data')
      .map((p) => ({
        name: toOrbitalFieldName(p.name),
        type: toOrbitalTypeSpec(p.type),
      }));

    return {
      name: ev.name,
      ...(ev.doc ? { doc: ev.doc } : {}),
      topics: [...prefixTopicFields, ...topicParams],
      data: dataParams,
    };
  });

  // Types
  const types: Record<string, OrbitalUserDefinedType> = {};
  for (const t of spec.types) {
    switch (t.kind) {
      case 'struct':
        types[t.name] = {
          kind: 'struct',
          name: t.name,
          ...(t.doc ? { doc: t.doc } : {}),
          fields: t.fields.map((f) => ({
            name: toOrbitalFieldName(f.name),
            type: toOrbitalTypeSpec(f.type),
            ...(f.doc ? { doc: f.doc } : {}),
          })),
        };
        break;
      case 'enum':
        types[t.name] = {
          kind: 'enum',
          name: t.name,
          ...(t.doc ? { doc: t.doc } : {}),
          variants: t.variants.map((v) => ({
            name: v.name,
            discriminant: v.value,
            ...(v.doc ? { doc: v.doc } : {}),
          })),
        };
        break;
      case 'union':
        types[t.name] = {
          kind: 'union',
          name: t.name,
          ...(t.doc ? { doc: t.doc } : {}),
          cases: t.cases.map((c) => ({
            name: c.name,
            ...(c.doc ? { doc: c.doc } : {}),
            fields: c.fields.map((f) => ({
              name: toOrbitalFieldName(f.name),
              type: toOrbitalTypeSpec(f.type),
              ...(f.doc ? { doc: f.doc } : {}),
            })),
          })),
        };
        break;
    }
  }

  // Contract errors: if any, group by error enum name and populate into types as 'enum'
  // if not already declared.
  if (spec.errors && spec.errors.length > 0) {
    const errorGroups = new Map<string, SpecErrorCase[]>();
    for (const err of spec.errors) {
      const existing = errorGroups.get(err.enumName) || [];
      existing.push(err);
      errorGroups.set(err.enumName, existing);
    }
    for (const [enumName, cases] of errorGroups) {
      if (!types[enumName]) {
        types[enumName] = {
          kind: 'enum',
          name: enumName,
          variants: cases.map((c) => ({
            name: c.name,
            discriminant: c.value,
            ...(c.doc ? { doc: c.doc } : {}),
          })),
        };
      }
    }
  }

  // Raw XDR entries (base64 string array)
  let xdrEntries: string[] | undefined;
  if ('entriesXdr' in spec && Array.isArray(spec.entriesXdr)) {
    xdrEntries = spec.entriesXdr;
  } else if ('entries' in spec && Array.isArray(spec.entries)) {
    xdrEntries = spec.entries.map((e) => (typeof e === 'string' ? e : (e.toXDR('base64') as string)));
  }

  return {
    version: options.version,
    name: options.name,
    ...(options.description ? { description: options.description } : {}),
    ...(options.contractId ? { contractId: options.contractId } : {}),
    ...(options.network ? { network: options.network } : {}),
    functions,
    events,
    types,
    ...(xdrEntries ? { xdrEntries } : {}),
  };
}
