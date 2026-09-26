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
  /** Optional documentation comment. */
  readonly doc?: string;
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
  /** Name of the error enum if part of a named error set. */
  readonly enumName?: string;
  /** Symbolic name of the error condition. */
  readonly name: string;
  /** Numeric error code (u32 value). */
  readonly value: number;
  /** Optional doc comment describing the failure. */
  readonly doc?: string;
}

/**
 * Contract event specification descriptor.
 * Corresponds to `xdr.ScSpecEventV0` (`scSpecEntryEventV0`).
 */
export interface SpecEvent {
  /** Symbolic event name. */
  readonly name: string;
  /** Optional doc comment. */
  readonly doc?: string;
  /** Topic descriptors. */
  readonly topics: readonly SpecField[];
  /** Payload data descriptors. */
  readonly data: readonly SpecField[];
}

/**
 * Build provenance metadata extracted from `contractmetav0`.
 */
export interface ContractBuild {
  /** Rust compiler version string, e.g. "1.91.1". */
  readonly rustVersion?: string;
  /** Soroban SDK version string, e.g. "26.1.0". */
  readonly sdkVersion?: string;
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
  /** Version of @stellar/stellar-sdk used to decode this spec. */
  readonly sdkVersion: string;
}
