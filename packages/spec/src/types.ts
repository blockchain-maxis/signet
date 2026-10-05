/**
 * @file @signet/spec
 *
 * Public specification types for Soroban smart contracts.
 *
 * Designed to mirror Orbital ABI shapes (for export compatibility) while providing
 * typed, flattened access to custom WASM custom sections (`contractspecv0`,
 * `contractmetav0`, `contractenvmetav0`).
 */

import type { contract, xdr } from '@stellar/stellar-sdk';

/**
 * Soroban atomic scalar / primitive type representations.
 * Corresponds to `xdr.ScSpecType` primitive values.
 *
 * Signet extensions — literals outside Orbital's primitive set, added so every
 * `xdr.ScSpecTypeDef` arm the pinned SDK defines has a primitive `TypeRef`:
 * `'val'`, `'timepoint'`, `'duration'` and `'muxedAddress'`. Consumers mapping
 * `TypeRef` onto an Orbital ABI must supply those four themselves (#439).
 */
export type PrimitiveType =
  | 'val'
  | 'void'
  | 'bool'
  | 'i32'
  | 'u32'
  | 'i64'
  | 'u64'
  | 'i128'
  | 'u128'
  | 'i256'
  | 'u256'
  | 'bytes'
  | 'string'
  | 'symbol'
  | 'address'
  | 'muxedAddress'
  | 'timepoint'
  | 'duration'
  | 'error';

/**
 * Fixed-length byte buffer reference (`bytes_n<N>`).
 * Corresponds to `xdr.ScSpecTypeBytesN` from `xdr.ScSpecTypeDef`.
 */
export type BytesNTypeRef = {
  readonly type: 'bytes_n';
  readonly n: number;
};

/**
 * Optional value reference (`Option<T>`).
 * Corresponds to `xdr.ScSpecTypeOption` from `xdr.ScSpecTypeDef`.
 */
export type OptionTypeRef = {
  readonly type: 'option';
  readonly value: TypeRef;
};

/**
 * Result value reference (`Result<T, E>`).
 * Corresponds to `xdr.ScSpecTypeResult` from `xdr.ScSpecTypeDef`.
 */
export type ResultTypeRef = {
  readonly type: 'result';
  readonly ok: TypeRef;
  readonly error: TypeRef;
};

/**
 * Homogeneous vector reference (`Vec<T>`).
 * Corresponds to `xdr.ScSpecTypeVec` from `xdr.ScSpecTypeDef`.
 */
export type VecTypeRef = {
  readonly type: 'vec';
  readonly element: TypeRef;
};

/**
 * Key-value map reference (`Map<K, V>`).
 * Corresponds to `xdr.ScSpecTypeMap` from `xdr.ScSpecTypeDef`.
 */
export type MapTypeRef = {
  readonly type: 'map';
  readonly key: TypeRef;
  readonly value: TypeRef;
};

/**
 * Fixed-size heterogeneous tuple reference (`Tuple`).
 * Corresponds to `xdr.ScSpecTypeTuple` from `xdr.ScSpecTypeDef`.
 */
export type TupleTypeRef = {
  readonly type: 'tuple';
  readonly elements: readonly TypeRef[];
};

/**
 * Named reference to a user-defined struct, union, or enum.
 * Corresponds to `xdr.ScSpecTypeUdt` from `xdr.ScSpecTypeDef`.
 */
export type NamedTypeRef = {
  readonly type: 'named';
  readonly name: string;
};

/**
 * Fallback representation for unrecognised or future XDR type arms.
 * Ensures newer specification extensions are visible rather than dropped.
 */
export type UnknownTypeRef = {
  readonly type: 'unknown';
  readonly xdrArm: string;
};

/**
 * Union of all Soroban type references.
 */
export type TypeRef =
  | PrimitiveType
  | BytesNTypeRef
  | OptionTypeRef
  | ResultTypeRef
  | VecTypeRef
  | MapTypeRef
  | TupleTypeRef
  | NamedTypeRef
  | UnknownTypeRef;

/**
 * Named and typed field descriptor used in function parameters, struct fields, and event data.
 * Corresponds to `xdr.ScSpecFunctionInputV0`, `xdr.ScSpecUdtStructFieldV0`, or event topic/data fields.
 */
export interface SpecField {
  /** Field identifier name. */
  readonly name: string;
  /** Optional documentation comment extracted from the contract. */
  readonly doc?: string;
  /** Type definition reference. */
  readonly type: TypeRef;
}

/**
 * Descriptor for an exported contract function.
 * Corresponds to `xdr.ScSpecFunctionV0` (`scSpecEntryFunctionV0`).
 */
export interface SpecFunction {
  /** Exported function name. */
  readonly name: string;
  /** Documentation comment; `''` when the function has none. */
  readonly doc: string;
  /** True for the contract constructor (`__constructor`). */
  readonly isConstructor: boolean;
  /** Ordered function arguments. */
  readonly inputs: readonly SpecField[];
  /** Function return type definitions. */
  readonly outputs: readonly TypeRef[];
}

/**
 * User-defined struct specification.
 * Corresponds to `xdr.ScSpecUdtStructV0` (`scSpecEntryUdtStructV0`).
 */
export interface SpecStruct {
  readonly kind: 'struct';
  /** Struct type name. */
  readonly name: string;
  /** Optional doc comment. */
  readonly doc?: string;
  /** Ordered struct fields. */
  readonly fields: readonly SpecField[];
}

/**
 * Single case in a discriminated union.
 * Corresponds to `xdr.ScSpecUdtUnionCaseV0`.
 */
export interface SpecUnionCase {
  /** Case name. */
  readonly name: string;
  /** Optional doc comment. */
  readonly doc?: string;
  /** Fields or payload carried by this union case. */
  readonly fields: readonly SpecField[];
}

/**
 * User-defined discriminated union specification.
 * Corresponds to `xdr.ScSpecUdtUnionV0` (`scSpecEntryUdtUnionV0`).
 */
export interface SpecUnion {
  readonly kind: 'union';
  /** Union type name. */
  readonly name: string;
  /** Optional doc comment. */
  readonly doc?: string;
  /** Tagged cases supported by this union. */
  readonly cases: readonly SpecUnionCase[];
}

/**
 * Single variant in a C-style or unit enum.
 * Corresponds to `xdr.ScSpecUdtEnumCaseV0`.
 */
export interface SpecEnumVariant {
  /** Variant name. */
  readonly name: string;
  /** Optional doc comment. */
  readonly doc?: string;
  /** Integer value / discriminant. */
  readonly value: number;
}

/**
 * User-defined enum specification.
 * Corresponds to `xdr.ScSpecUdtEnumV0` (`scSpecEntryUdtEnumV0`).
 */
export interface SpecEnum {
  readonly kind: 'enum';
  /** Enum type name. */
  readonly name: string;
  /** Optional doc comment. */
  readonly doc?: string;
  /** Variants defined for this enum. */
  readonly variants: readonly SpecEnumVariant[];
}

/**
 * Discriminated union of all user-defined types.
 */
export type SpecType = SpecStruct | SpecUnion | SpecEnum;

/**
 * Error case definition within a contract error enum.
 * Corresponds to `xdr.ScSpecUdtErrorEnumCaseV0` from `scSpecEntryUdtErrorEnumV0`.
 */
export interface SpecErrorCase {
  /** Name of the error enum that declares this case. */
  readonly enumName: string;
  /** Symbolic name of the error condition. */
  readonly name: string;
  /** Numeric error code (u32 value). */
  readonly value: number;
  /** Doc comment describing the failure; `''` when absent. */
  readonly doc: string;
}

/**
 * Where an event parameter is carried on the emitted event.
 * Corresponds to `xdr.ScSpecEventParamLocationV0`.
 */
export type SpecEventParamLocation = 'topic' | 'data';

/**
 * How the non-topic parameters are packed into the event's data value.
 * Corresponds to `xdr.ScSpecEventDataFormat`.
 */
export type SpecEventDataFormat = 'single_value' | 'vec' | 'map';

/**
 * A single event parameter.
 * Corresponds to `xdr.ScSpecEventParamV0`.
 */
export interface SpecEventParam {
  /** Parameter name. */
  readonly name: string;
  /** Type definition reference. */
  readonly type: TypeRef;
  /** Whether the parameter is a topic or part of the data payload. */
  readonly location: SpecEventParamLocation;
}

/**
 * Contract event specification descriptor.
 * Corresponds to `xdr.ScSpecEventV0` (`scSpecEntryEventV0`, SEP-48).
 */
export interface SpecEvent {
  /** Event name (the struct name for `#[contractevent]`). */
  readonly name: string;
  /** Doc comment; `''` when absent. */
  readonly doc: string;
  /** Leading topic symbols emitted before any topic parameters. */
  readonly prefixTopics: readonly string[];
  /** Parameters in declaration order, each flagged as topic or data. */
  readonly params: readonly SpecEventParam[];
  /** How the data parameters are packed into the event's data value. */
  readonly dataFormat: SpecEventDataFormat;
}

/**
 * Build provenance metadata extracted from `contractmetav0`.
 */
export interface ContractBuild {
  /** Rust compiler version string, e.g. "1.91.1". */
  readonly rustVersion?: string;
  /** Soroban SDK version string, e.g. "26.1.0". */
  readonly sdkVersion?: string;
  /**
   * Every `contractmetav0` key/value pair, including keys this package does
   * not know (`rsver` and `rssdkver` appear here too).
   */
  readonly entries: Readonly<Record<string, string>>;
}

/**
 * Environment metadata extracted from `contractenvmetav0`.
 */
export interface ContractEnvMeta {
  /** Protocol interface version the contract was built against. */
  readonly protocolVersion: number;
  /** Pre-release version number. */
  readonly preRelease: number;
}

/**
 * Canonical decoded specification model for a deployed Soroban contract.
 *
 * Exposes both raw XDR and SDK wrappers alongside flattened representations
 * of functions, types, errors, events, and build metadata.
 */
export interface ContractSpec {
  /** Hex-encoded SHA-256 hash of the contract executable WASM. */
  readonly wasmHash: string;
  /** Raw decoded XDR entries from the `contractspecv0` section. */
  readonly entries: readonly xdr.ScSpecEntry[];
  /** Stellar SDK `contract.Spec` helper instance. */
  readonly spec: contract.Spec;
  /** Flattened list of contract functions. */
  readonly functions: readonly SpecFunction[];
  /** Flattened user-defined types (structs, unions, enums). */
  readonly types: readonly SpecType[];
  /** Flattened list of error codes and descriptions. */
  readonly errors: readonly SpecErrorCase[];
  /** Contract events emitted by the contract. */
  readonly events: readonly SpecEvent[];
  /** Build metadata extracted from `contractmetav0`. */
  readonly build?: ContractBuild;
  /** Protocol interface version from `contractenvmetav0`. */
  readonly env?: ContractEnvMeta;
  /**
   * Non-fatal notes from decoding, e.g. a `contractmetav0` section that could
   * not be read (`build` is then undefined). Empty when nothing went wrong.
   */
  readonly warnings: readonly string[];
  /** Version of @stellar/stellar-sdk used to decode this spec. */
  readonly sdkVersion: string;
}
