/**
 * @file @signet/spec — stable JSON serialisation (B-11).
 *
 * `ContractSpec` holds XDR objects and a `contract.Spec` instance, so it
 * cannot cross a process boundary. The API (`/api/v1`), the Go CLI, the
 * Postgres cache and React server-to-client props all need one versioned,
 * deterministic JSON form — this module. It is deterministic so its hash can
 * serve as an ETag.
 *
 * `entriesXdr` is the source of truth: every entry's canonical XDR bytes as
 * base64. The flattened views (`functions`, `types`, `errors`, `events`) are
 * carried alongside for consumers that never want to touch XDR, and
 * `fromSpecJson` does not recompute them — it copies them verbatim and
 * rebuilds only `entries` and `spec` from `entriesXdr`.
 *
 * This module is environment-agnostic on purpose: no `node:` imports, no
 * `fetch`, no filesystem. Readers that fetch (Horizon, RPC) live elsewhere
 * and convert at the boundary through `toSpecJson` / `fromSpecJson`, so this
 * file stays importable from browsers, workers and the Go-adjacent tooling
 * alike. Keep it that way.
 */

import { contract, xdr } from '@stellar/stellar-sdk';
import type {
  ContractBuild,
  ContractEnvMeta,
  ContractSpec,
  SpecErrorCase,
  SpecEvent,
  SpecField,
  SpecFunction,
  SpecType,
  TypeRef,
} from './types.ts';

/** Current `SpecJson` schema version. See `schemaVersion` below for the bump policy. */
export const SPEC_JSON_SCHEMA_VERSION = 1;

/**
 * Versioned, deterministic JSON form of a `ContractSpec`.
 *
 * `entriesXdr` carries every entry in decode order; consumers that need the
 * SDK back call `fromSpecJson`, everyone else reads the flattened views.
 * `warnings` records non-fatal extraction notes (e.g. future XDR arms the
 * reader surfaced as `unknown` rather than dropping).
 */
export interface SpecJson {
  /** Schema version. Must be `SPEC_JSON_SCHEMA_VERSION`; renames and removals need a new one. */
  schemaVersion: 1;
  /** Hex-encoded SHA-256 hash of the contract executable WASM. */
  wasmHash: string;
  /** Version of @stellar/stellar-sdk that decoded this spec. */
  sdkVersion: string;
  /** Every entry's canonical XDR bytes as base64, in decode order. The source of truth. */
  entriesXdr: string[];
  functions: SpecFunction[];
  types: SpecType[];
  errors: SpecErrorCase[];
  events: SpecEvent[];
  build?: ContractBuild;
  env?: ContractEnvMeta;
  warnings: string[];
}

/** Optional extraction notes attached at serialisation time. Defaults to `[]`. */
export interface ToSpecJsonOptions {
  warnings?: readonly string[];
}

function copyTypeRef(type: TypeRef): TypeRef {
  if (typeof type === 'string') return type;
  switch (type.type) {
    case 'bytes_n':
      return { type: 'bytes_n', n: type.n };
    case 'option':
      return { type: 'option', value: copyTypeRef(type.value) };
    case 'result':
      return { type: 'result', ok: copyTypeRef(type.ok), error: copyTypeRef(type.error) };
    case 'vec':
      return { type: 'vec', element: copyTypeRef(type.element) };
    case 'map':
      return { type: 'map', key: copyTypeRef(type.key), value: copyTypeRef(type.value) };
    case 'tuple':
      return { type: 'tuple', elements: type.elements.map(copyTypeRef) };
    case 'named':
      return { type: 'named', name: type.name };
    case 'unknown':
      return { type: 'unknown', xdrArm: type.xdrArm };
  }
}

function copyField(field: SpecField): SpecField {
  return {
    name: field.name,
    ...(field.doc !== undefined ? { doc: field.doc } : {}),
    type: copyTypeRef(field.type),
  };
}

function copyFunction(fn: SpecFunction): SpecFunction {
  return {
    name: fn.name,
    doc: fn.doc,
    isConstructor: fn.isConstructor,
    inputs: fn.inputs.map(copyField),
    outputs: fn.outputs.map(copyTypeRef),
  };
}

/**
 * Serialise a `ContractSpec` to its stable JSON form.
 *
 * The flattened views are copied field-by-field (never referenced): `entries`
 * are XDR objects the JSON must not alias, and a JSON payload that shares
 * structure with a live spec would let a consumer mutate the reader's state.
 * Optional `doc` fields keep their presence — absent stays absent — so a
 * round-trip deep-equals the input.
 */
export function toSpecJson(spec: ContractSpec, options: ToSpecJsonOptions = {}): SpecJson {
  return {
    schemaVersion: SPEC_JSON_SCHEMA_VERSION,
    wasmHash: spec.wasmHash,
    sdkVersion: spec.sdkVersion,
    entriesXdr: spec.entries.map((entry) => entry.toXDR('base64') as string),
    functions: spec.functions.map(copyFunction),
    types: spec.types.map((t) => {
      switch (t.kind) {
        case 'struct':
          return {
            kind: 'struct' as const,
            name: t.name,
            ...(t.doc !== undefined ? { doc: t.doc } : {}),
            fields: t.fields.map(copyField),
          };
        case 'union':
          return {
            kind: 'union' as const,
            name: t.name,
            ...(t.doc !== undefined ? { doc: t.doc } : {}),
            cases: t.cases.map((c) => ({
              name: c.name,
              ...(c.doc !== undefined ? { doc: c.doc } : {}),
              fields: c.fields.map(copyField),
            })),
          };
        case 'enum':
          return {
            kind: 'enum' as const,
            name: t.name,
            ...(t.doc !== undefined ? { doc: t.doc } : {}),
            variants: t.variants.map((v) => ({
              name: v.name,
              ...(v.doc !== undefined ? { doc: v.doc } : {}),
              value: v.value,
            })),
          };
      }
    }),
    errors: spec.errors.map((e) => ({
      enumName: e.enumName,
      name: e.name,
      value: e.value,
      doc: e.doc,
    })),
    events: spec.events.map((e) => ({
      name: e.name,
      doc: e.doc,
      prefixTopics: [...e.prefixTopics],
      params: e.params.map((p) => ({
        name: p.name,
        type: copyTypeRef(p.type),
        location: p.location,
      })),
      dataFormat: e.dataFormat,
    })),
    ...(spec.build !== undefined ? { build: { ...spec.build } } : {}),
    ...(spec.env !== undefined ? { env: { ...spec.env } } : {}),
    warnings: [...(options.warnings ?? [])],
  };
}

/**
 * Rebuild a `ContractSpec` from its JSON form.
 *
 * `entries` are decoded from `entriesXdr` and `spec` is reconstructed with
 * `new contract.Spec(entries)`; the flattened views are copied verbatim, not
 * recomputed. Throws when `schemaVersion` is not `SPEC_JSON_SCHEMA_VERSION`
 * (migrations belong in a versioned reader, not a silent coercion) and lets
 * undecodable entries propagate the SDK's XDR error.
 */
export function fromSpecJson(json: SpecJson): ContractSpec {
  if (json.schemaVersion !== SPEC_JSON_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported SpecJson schemaVersion ${json.schemaVersion as number}; this reader handles v${SPEC_JSON_SCHEMA_VERSION}`,
    );
  }
  const entries = json.entriesXdr.map((b64) => xdr.ScSpecEntry.fromXDR(b64, 'base64'));
  return {
    wasmHash: json.wasmHash,
    entries,
    spec: new contract.Spec(entries),
    functions: json.functions,
    types: json.types,
    errors: json.errors,
    events: json.events,
    ...(json.build !== undefined ? { build: json.build } : {}),
    ...(json.env !== undefined ? { env: json.env } : {}),
    sdkVersion: json.sdkVersion,
  };
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortedKeys(record[key])]),
    );
  }
  return value;
}

/**
 * Deterministic serialisation of a `SpecJson`: object keys sorted recursively
 * (arrays keep their order — entry and input order is semantic), same rule as
 * Orbital's `canonicalizeSpec`. Byte-identical across runs and across
 * key-insertion orders, so `sha256(canonicalStringify(json))` is a stable
 * ETag for the API, the CLI and the Postgres cache to agree on.
 */
export function canonicalStringify(json: SpecJson): string {
  return JSON.stringify(sortedKeys(json));
}
