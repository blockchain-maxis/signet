/**
 * @file @signet/spec — JSON Schema generation per function arguments (B-15).
 *
 * The sandbox's input form, example invocation generation, and request validation
 * all need a self-contained JSON Schema for each function's arguments.
 *
 * This module wraps Stellar SDK's `contract.Spec#jsonSchema(fnName)` and normalises
 * the output into a self-contained object schema representing `{ [argName]: argValue }`.
 *
 * ### Encoding Conventions (pinned against `@stellar/stellar-sdk`):
 *
 * 1. **Large Integers (`i64`, `u64`, `i128`, `u128`, `i256`, `u256`) and Time**:
 *    - Represented as decimal numeric **`string`**s with bounded regex patterns:
 *      - `U64`, `Timepoint`, `Duration`, `U128`, `U256`: `^([1-9][0-9]*|0)$`
 *      - `I64`, `I128`, `I256`: `^(-?[1-9][0-9]*|0)$`
 *    - They are NOT JSON numbers, preventing JavaScript IEEE 754 precision loss
 *      for values exceeding 53 bits (e.g. `Number.MAX_SAFE_INTEGER`).
 *
 * 2. **Address (`Address`, `MuxedAddress`)**:
 *    - Encoded as a **`string`** with `format: "address"` and descriptions noting
 *      public key (G...) or contract ID (C...).
 *
 * 3. **Byte Buffers (`bytes`, `BytesN`)**:
 *    - Encoded as a DataUrl/base64 **`string`** matching the base64 regex pattern:
 *      `^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$`
 *    - For fixed-length `BytesN<N>`, the schema carries `maxLength: N`.
 *
 * 4. **Optional Values (`Option<T>`)**:
 *    - The argument property is typed directly as the inner type `T`, but its name
 *      is **omitted** from the root schema's `required` list.
 *    - All non-optional arguments are explicitly listed in `required`.
 *
 * 5. **Self-Contained Structure and Pruned Definitions**:
 *    - The schema root is an `object` whose `properties` map argument names to their
 *      type schemas in declaration order.
 *    - `definitions` is strictly pruned: only UDTs and primitive schemas reachable
 *      via `$ref` from the function's arguments are included; unrelated contract
 *      functions, unreachable types, and unused primitives are stripped.
 *    - `additionalProperties: false` ensures strict argument validation.
 *
 * 6. **Quirk Normalisation**:
 *    - The Stellar SDK emits union tag properties as bare literals (e.g. `"tag": "Point"`)
 *      which is invalid JSON Schema draft-7. This module normalises any literal property
 *      value into `{ "type": "string", "const": value }` so every schema compiles cleanly.
 */

import { contract, xdr } from '@stellar/stellar-sdk';
import type { ContractSpec } from './types.ts';
import type { SpecJson } from './json.ts';

export type JSONSchema7 = {
  $schema?: string;
  $id?: string;
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | unknown;
  definitions?: Record<string, unknown>;
  description?: string;
  [key: string]: unknown;
};

/** Spec inputs acceptable by JSON Schema helpers. */
export type SpecInput =
  | ContractSpec
  | SpecJson
  | contract.Spec
  | readonly xdr.ScSpecEntry[];

/** Helper to extract or construct a `contract.Spec` instance. */
function toSdkSpec(input: SpecInput): contract.Spec {
  if (input instanceof contract.Spec) {
    return input;
  }
  if ('spec' in input && input.spec instanceof contract.Spec) {
    return input.spec;
  }
  if ('entries' in input && Array.isArray(input.entries)) {
    return new contract.Spec(input.entries as xdr.ScSpecEntry[]);
  }
  if ('entriesXdr' in input && Array.isArray(input.entriesXdr)) {
    const entries = input.entriesXdr.map((b64) => xdr.ScSpecEntry.fromXDR(b64, 'base64'));
    return new contract.Spec(entries);
  }
  if (Array.isArray(input)) {
    return new contract.Spec(input as xdr.ScSpecEntry[]);
  }
  throw new Error('Unsupported spec format for json-schema generation');
}

/** Recursively normalise SDK schema quirks into valid JSON Schema draft-7. */
function normalizeSchemaNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map(normalizeSchemaNode);
  }
  const record = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const normalizedProps: Record<string, unknown> = {};
      for (const [propName, propVal] of Object.entries(value as Record<string, unknown>)) {
        if (typeof propVal === 'string' || typeof propVal === 'number' || typeof propVal === 'boolean') {
          normalizedProps[propName] = { type: typeof propVal, const: propVal };
        } else {
          normalizedProps[propName] = normalizeSchemaNode(propVal);
        }
      }
      result[key] = normalizedProps;
    } else {
      result[key] = normalizeSchemaNode(value);
    }
  }

  return result;
}

/** Recursively collect all `#/definitions/{name}` references from an object tree. */
function collectRefs(node: unknown, into: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, into);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record['$ref'] === 'string') {
    const match = record['$ref'].match(/^#\/definitions\/(.+)$/);
    if (match && match[1]) {
      into.add(match[1]);
    }
  }
  for (const value of Object.values(record)) {
    collectRefs(value, into);
  }
}

/**
 * Generate a self-contained JSON Schema for a single function's arguments.
 *
 * @param spec - The contract spec (ContractSpec, SpecJson, or contract.Spec).
 * @param fnName - The exported contract function name.
 * @returns A JSONSchema7 object schema with argument properties and pruned definitions.
 */
export function functionArgsSchema(spec: SpecInput, fnName: string): JSONSchema7 {
  const sdkSpec = toSdkSpec(spec);
  let raw: { definitions?: Record<string, unknown> };
  try {
    raw = sdkSpec.jsonSchema(fnName) as { definitions?: Record<string, unknown> };
  } catch (err) {
    throw new Error(
      `Failed to generate JSON Schema for function "${fnName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const allDefinitions = raw.definitions ?? {};
  const fnDef = allDefinitions[fnName] as Record<string, unknown> | undefined;
  if (!fnDef) {
    throw new Error(`Function "${fnName}" not found in contract spec`);
  }

  const fnProps = fnDef.properties as Record<string, unknown> | undefined;
  const argsObj = fnProps?.args as Record<string, unknown> | undefined;
  const properties = (argsObj?.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(argsObj?.required) ? (argsObj.required as string[]) : [];

  // Transitive closure of all definitions reachable from `properties`
  const visited = new Set<string>();
  const queue: string[] = [];

  const initialRefs = new Set<string>();
  collectRefs(properties, initialRefs);
  for (const ref of initialRefs) {
    visited.add(ref);
    queue.push(ref);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const def = allDefinitions[current];
    if (def) {
      const nestedRefs = new Set<string>();
      collectRefs(def, nestedRefs);
      for (const ref of nestedRefs) {
        if (!visited.has(ref)) {
          visited.add(ref);
          queue.push(ref);
        }
      }
    }
  }

  const prunedDefinitions: Record<string, unknown> = {};
  for (const name of Array.from(visited).sort()) {
    if (name in allDefinitions) {
      prunedDefinitions[name] = normalizeSchemaNode(allDefinitions[name]);
    }
  }

  const normalizedProperties = normalizeSchemaNode(properties) as Record<string, unknown>;

  const schema: JSONSchema7 = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: normalizedProperties,
    additionalProperties: false,
  };

  if (required.length > 0) {
    schema.required = required;
  }

  if (typeof fnDef.description === 'string' && fnDef.description.trim().length > 0) {
    schema.description = fnDef.description;
  }

  if (Object.keys(prunedDefinitions).length > 0) {
    schema.definitions = prunedDefinitions;
  }

  return schema;
}

/**
 * Generate JSON Schemas for all exported functions in a contract spec.
 *
 * @param spec - The contract spec.
 * @returns Map from function name to its arguments JSON Schema.
 */
export function allFunctionSchemas(spec: SpecInput): Record<string, JSONSchema7> {
  const sdkSpec = toSdkSpec(spec);
  const result: Record<string, JSONSchema7> = {};

  for (const fn of sdkSpec.funcs()) {
    const name = fn.name().toString();
    result[name] = functionArgsSchema(sdkSpec, name);
  }

  return result;
}
