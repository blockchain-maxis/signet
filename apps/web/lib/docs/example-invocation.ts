/**
 * @file apps/web/lib/docs/example-invocation.ts
 *
 * Example invocations generated from JSON Schema (D-13, #476).
 *
 * A reader who wants to call a function needs the shape of a call.
 * The JSON Schema says what each argument's type and encoding is, so an example
 * can be generated. It is an example of the call's shape and it knows nothing
 * about valid values.
 *
 * Caption verbatim:
 * "Placeholder values. This shows the argument shape only. It does not show who
 * is authorised to call this function, what it costs or whether the call succeeds."
 */

import type { JSONSchema7 } from '@signet/spec';

export const EXAMPLE_INVOCATION_CAPTION =
  'Placeholder values. This shows the argument shape only. It does not show who is authorised to call this function, what it costs or whether the call succeeds.';

interface SchemaNode {
  type?: string | string[];
  $ref?: string;
  format?: string;
  description?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode | SchemaNode[];
  oneOf?: SchemaNode[];
  enum?: unknown[];
  const?: unknown;
  additionalProperties?: boolean | unknown;
}

function resolveRef(schema: SchemaNode, root: SchemaNode): SchemaNode {
  if (schema.$ref && typeof schema.$ref === 'string') {
    const prefix = '#/definitions/';
    if (schema.$ref.startsWith(prefix)) {
      const defName = schema.$ref.slice(prefix.length);
      const definitions = (root as { definitions?: Record<string, SchemaNode> }).definitions;
      if (definitions && definitions[defName]) {
        return definitions[defName];
      }
    }
  }
  return schema;
}

/**
 * Generate obviously-placeholder values per type.
 *
 * Rules from issue #476:
 * - "<address>" for addresses
 * - 0 for integers
 * - "<32 bytes hex>" for BytesN<32>
 * - null for Option (omitted from required in schema)
 * - false for booleans
 * - never realistic-looking addresses or amounts
 */
export function exampleValue(node: SchemaNode, root: SchemaNode): unknown {
  const s = resolveRef(node, root);

  // Address check (format: "address" or description)
  if (
    s.format === 'address' ||
    (typeof s.description === 'string' && s.description.toLowerCase().includes('address'))
  ) {
    return '<address>';
  }

  // Large integers or BytesN or Strings
  if (s.type === 'string') {
    if (s.maxLength === 32 && s.pattern) {
      // BytesN<32>
      return '<32 bytes hex>';
    }
    // Pattern for large integers: e.g. U64, I64, U128, etc. -> '0' (numeric string per json-schema spec)
    if (s.pattern === '^([1-9][0-9]*|0)$' || s.pattern === '^(-?[1-9][0-9]*|0)$') {
      return '0';
    }
    // Base64 bytes (DataUrl)
    if (s.pattern && s.pattern.includes('A-Za-z0-9')) {
      return '<32 bytes hex>';
    }
    return '<string>';
  }

  // Integer or number
  if (s.type === 'integer' || s.type === 'number') {
    return 0;
  }

  // Boolean
  if (s.type === 'boolean') {
    return false;
  }

  // Array / Tuple / Vec
  if (s.type === 'array') {
    if (Array.isArray(s.items)) {
      return s.items.map((item) => exampleValue(item, root));
    }
    if (s.items && typeof s.items === 'object') {
      return [exampleValue(s.items, root)];
    }
    return [];
  }

  // Object / Struct
  if (s.type === 'object') {
    if (s.properties) {
      const obj: Record<string, unknown> = {};
      const required = new Set(s.required ?? Object.keys(s.properties));
      for (const [key, prop] of Object.entries(s.properties)) {
        if (prop.const !== undefined) {
          obj[key] = prop.const;
        } else if (required.has(key)) {
          obj[key] = exampleValue(prop, root);
        } else {
          obj[key] = null;
        }
      }
      return obj;
    }
    return {};
  }

  // Enum or Union (oneOf)
  if (Array.isArray(s.oneOf) && s.oneOf.length > 0) {
    const first = s.oneOf[0]!;
    if (Array.isArray(first.enum) && first.enum.length > 0) {
      return first.enum[0];
    }
    return exampleValue(first, root);
  }

  return '<value>';
}

/**
 * Generate obviously-placeholder arguments object from a function's JSON Schema.
 * Optional properties (omitted from `required`) receive `null`.
 */
export function exampleArgs(schema: JSONSchema7): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const root = schema as SchemaNode;
  const properties = (schema.properties ?? {}) as Record<string, SchemaNode>;
  const required = new Set(schema.required ?? []);

  for (const [name, propSchema] of Object.entries(properties)) {
    if (!required.has(name)) {
      result[name] = null;
    } else {
      result[name] = exampleValue(propSchema, root);
    }
  }

  return result;
}

export interface CliSnippetOptions {
  address?: string;
  network?: string;
  fnName: string;
  schema: JSONSchema7;
}

/**
 * Render a stellar contract invoke snippet:
 * `stellar contract invoke --id {address} --network {network} -- {fn} --arg value …`
 */
export function renderCliSnippet(options: CliSnippetOptions): string {
  const { address = '{address}', network = '{network}', fnName, schema } = options;
  const args = exampleArgs(schema);
  const parts = [`stellar contract invoke --id ${address} --network ${network} -- ${fnName}`];

  for (const [key, val] of Object.entries(args)) {
    if (val === null) continue; // Optional arg skipped in basic invocation
    let formattedVal: string;
    if (typeof val === 'string') {
      formattedVal = val;
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      formattedVal = String(val);
    } else {
      formattedVal = JSON.stringify(val);
    }
    parts.push(`--${key} ${formattedVal}`);
  }

  return parts.join(' ');
}

export interface TypeScriptSnippetOptions {
  contractId?: string;
  networkPassphrase?: string;
  rpcUrl?: string;
  fnName: string;
  schema: JSONSchema7;
}

/**
 * Render a TypeScript snippet using contract.Client.from:
 * ```typescript
 * import { contract } from '@stellar/stellar-sdk';
 *
 * const client = await contract.Client.from({
 *   contractId,
 *   networkPassphrase,
 *   rpcUrl,
 * });
 *
 * const result = await client.{fn}({ ... });
 * ```
 */
export function renderTypeScriptSnippet(options: TypeScriptSnippetOptions): string {
  const {
    contractId = '{contractId}',
    networkPassphrase = '{networkPassphrase}',
    rpcUrl = '{rpcUrl}',
    fnName,
    schema,
  } = options;
  const args = exampleArgs(schema);

  const formattedArgs = JSON.stringify(args, null, 2)
    .split('\n')
    .map((line, idx) => (idx === 0 ? line : `  ${line}`))
    .join('\n');

  return `import { contract } from '@stellar/stellar-sdk';

const client = await contract.Client.from({
  contractId: '${contractId}',
  networkPassphrase: '${networkPassphrase}',
  rpcUrl: '${rpcUrl}',
});

const result = await client.${fnName}(${formattedArgs});`;
}
