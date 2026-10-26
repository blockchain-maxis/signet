/**
 * The published API reference (#649), built at build time from the committed
 * OpenAPI snapshot, `docs/api/openapi-v1.json` (#648), so the pages document
 * exactly what CI checked the API against.
 *
 * Pure functions over the document: the pages render what these return, and
 * the tests check them without a build.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ApiSchema {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  format?: string;
  pattern?: string;
  description?: string;
  properties?: Record<string, ApiSchema>;
  required?: string[];
  items?: ApiSchema;
  allOf?: ApiSchema[];
  additionalProperties?: boolean | ApiSchema;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  definitions?: Record<string, ApiSchema>;
}

export interface ApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: ApiSchema;
}

export interface ApiResponse {
  description?: string;
  headers?: Record<string, { description?: string; schema?: ApiSchema }>;
  content?: Record<string, { schema?: ApiSchema }>;
}

export interface ApiOperation {
  operationId: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: ApiParameter[];
  responses: Record<string, ApiResponse>;
}

export interface ApiDocument {
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, ApiOperation>>;
  components: { schemas: Record<string, ApiSchema> };
}

/** An operation with where it lives. */
export interface ReferenceOperation extends ApiOperation {
  method: string;
  path: string;
}

/**
 * The committed snapshot. `next build` runs with apps/web as its working
 * directory; the tests run from it too.
 */
export function loadApiDocument(): ApiDocument {
  const file = join(process.cwd(), '../../docs/api/openapi-v1.json');
  return JSON.parse(readFileSync(file, 'utf8')) as ApiDocument;
}

/** Every operation, grouped by tag order of first appearance, then by path. */
export function listOperations(doc: ApiDocument): ReferenceOperation[] {
  const ops: ReferenceOperation[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (op && typeof op === 'object' && 'operationId' in op) {
        ops.push({ ...op, method: method.toUpperCase(), path });
      }
    }
  }
  const tagOrder = [...new Set(ops.map((o) => o.tags?.[0] ?? 'Other'))];
  return ops.sort(
    (a, b) =>
      tagOrder.indexOf(a.tags?.[0] ?? 'Other') - tagOrder.indexOf(b.tags?.[0] ?? 'Other') ||
      a.path.localeCompare(b.path),
  );
}

export function findOperation(doc: ApiDocument, operationId: string): ReferenceOperation | null {
  return listOperations(doc).find((o) => o.operationId === operationId) ?? null;
}

/** Follows a local `$ref` (including one into a schema's own definitions). */
export function resolveSchema(doc: ApiDocument, schema: ApiSchema | undefined): ApiSchema {
  let s = schema ?? {};
  for (let hops = 0; s.$ref && hops < 10; hops++) {
    const parts = s.$ref.replace(/^#\//, '').split('/');
    let node: unknown = doc;
    for (const part of parts) node = (node as Record<string, unknown> | undefined)?.[part];
    s = (node as ApiSchema | undefined) ?? {};
  }
  if (s.allOf) {
    // Merge the parts: properties and required lists combine.
    const merged: ApiSchema = { type: 'object', properties: {}, required: [] };
    for (const part of s.allOf.map((p) => resolveSchema(doc, p))) {
      Object.assign(merged.properties!, part.properties ?? {});
      merged.required!.push(...(part.required ?? []));
      merged.description ??= part.description;
    }
    return merged;
  }
  return s;
}

/** The name of a `$ref` target, for a type column. */
function refName(schema: ApiSchema | undefined): string | null {
  return schema?.$ref ? schema.$ref.split('/').pop()! : null;
}

/** A short type label: `string`, `integer | null`, `"a" | "b"`, `Contract[]`. */
export function typeLabel(doc: ApiDocument, schema: ApiSchema | undefined): string {
  const named = refName(schema);
  if (named) return named;
  const s = resolveSchema(doc, schema);
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (types.includes('array')) {
    const item = typeLabel(doc, s.items);
    return `${item.includes(' ') ? `(${item})` : item}[]${types.includes('null') ? ' | null' : ''}`;
  }
  return types.length ? types.join(' | ') : s.properties ? 'object' : 'any';
}

export interface SchemaRow {
  /** Dotted path, `data.attribution.method`; `[]` marks an array's items. */
  name: string;
  type: string;
  required: boolean;
  description: string;
  depth: number;
}

/**
 * A schema as readable rows: one per property, nested objects and array
 * items indented under their parent, down to `maxDepth`. Named component
 * schemas are expanded once per branch, so a recursive one cannot loop.
 */
export function schemaRows(
  doc: ApiDocument,
  schema: ApiSchema | undefined,
  maxDepth = 3,
): SchemaRow[] {
  const rows: SchemaRow[] = [];
  const walk = (s: ApiSchema | undefined, prefix: string, depth: number, seen: Set<string>) => {
    const ref = s?.$ref;
    if (ref && seen.has(ref)) return;
    const next = ref ? new Set([...seen, ref]) : seen;
    const r = resolveSchema(doc, s);
    const types = Array.isArray(r.type) ? r.type : r.type ? [r.type] : [];
    if (types.includes('array') && r.items) {
      walk(r.items, `${prefix}[]`, depth, next);
      return;
    }
    if (!r.properties || depth > maxDepth) return;
    for (const [key, prop] of Object.entries(r.properties)) {
      const name = prefix ? `${prefix}.${key}` : key;
      const resolved = resolveSchema(doc, prop);
      rows.push({
        name,
        type: typeLabel(doc, prop),
        required: (r.required ?? []).includes(key),
        description: resolved.description ?? prop.description ?? '',
        depth,
      });
      walk(prop, name, depth + 1, next);
    }
  };
  walk(schema, '', 0, new Set());
  return rows;
}

/** Example values, so every snippet on the site uses the same ones. */
export const EXAMPLE = {
  handle: 'alice',
  account: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  contract: 'CAMYYJCHOQZSTF2KF6WY4UMFXS75VI46NEGKWE6XHWFULYD46BE5EUXZ',
  wasmHash: 'b2a1f39f0e8f1c5bd3a2e6c1d0f4b7a8c9e2d1f0a3b4c5d6e7f8091a2b3c4d5e',
  time: '2026-09-20T12:00:00.000Z',
};

/** Example values for bare string fields, by name. */
const NAMED_EXAMPLES: Record<string, string> = {
  handle: EXAMPLE.handle,
  wallet: EXAMPLE.account,
  deployer: EXAMPLE.account,
  address: EXAMPLE.account,
  primaryWallet: EXAMPLE.account,
  name: 'identity-registry',
};

/** A plausible example value for a schema, from its enum, pattern or type. */
export function exampleFor(doc: ApiDocument, schema: ApiSchema | undefined, depth = 0): unknown {
  const s = resolveSchema(doc, schema);
  if (s.const !== undefined) return s.const;
  if (s.enum) return s.enum.find((v) => v !== null) ?? null;
  if (s.default !== undefined) return s.default;
  const types = (Array.isArray(s.type) ? s.type : s.type ? [s.type] : []).filter(
    (t) => t !== 'null',
  );
  const type = types[0] ?? (s.properties ? 'object' : undefined);
  if (depth > 4) return type === 'array' ? [] : type === 'object' ? {} : null;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        const value = exampleFor(doc, v, depth + 1);
        // A bare string field is better named by its key than "string".
        out[k] = value === 'string' ? (NAMED_EXAMPLES[k] ?? value) : value;
      }
      return out;
    }
    case 'array':
      return s.items ? [exampleFor(doc, s.items, depth + 1)] : [];
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' && s.minimum > 3 ? s.minimum : 3;
    case 'boolean':
      return false;
    case 'string': {
      const p = s.pattern ?? '';
      if (s.format === 'date-time') return EXAMPLE.time;
      if (p.startsWith('^C')) return EXAMPLE.contract;
      if (p.startsWith('^G') || p.startsWith('^[GC]')) return EXAMPLE.account;
      if (/a-f0-9|0-9a-f/.test(p)) return EXAMPLE.wasmHash;
      if (p.startsWith('^[a-z0-9')) return EXAMPLE.handle;
      return 'string';
    }
    default:
      return null;
  }
}

/** A path with its parameters filled with the example values. */
export function examplePath(path: string): string {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (name === 'handle') return EXAMPLE.handle;
    if (name === 'wasmHash') return EXAMPLE.wasmHash;
    if (name === 'address') return path.startsWith('/lookup/') ? EXAMPLE.account : EXAMPLE.contract;
    return name;
  });
}

/** A runnable curl for an operation against `baseUrl` (which ends in /api/v1). */
export function curlExample(baseUrl: string, op: ReferenceOperation): string {
  const query = (op.parameters ?? [])
    .filter((p) => p.in === 'query' && p.name === 'limit')
    .map((p) => `${p.name}=${p.schema?.default ?? 25}`);
  const url = `${baseUrl}${examplePath(op.path)}${query.length ? `?${query.join('&')}` : ''}`;
  return `curl -s ${op.path.endsWith('.svg') ? '' : '-H "Accept: application/json" '}"${url}"`;
}

/** The `@signet/sdk` call for an operation, or null when the SDK has none. */
const SDK_CALLS: Record<string, string> = {
  getProfile: `signet.getProfile('${EXAMPLE.handle}')`,
  getHandleWallets: `signet.getWallets('${EXAMPLE.handle}')`,
  getProfileContracts: `signet.listContracts('${EXAMPLE.handle}', { limit: 25 })`,
  getProfileContract: `signet.getContract('${EXAMPLE.handle}', '${EXAMPLE.contract}')`,
  getProfileOperations: `signet.listOperations('${EXAMPLE.handle}', { limit: 25 })`,
  getContractSpec: `signet.getContractSpec('${EXAMPLE.contract}')`,
  getSpecByHash: `signet.getSpecByHash('${EXAMPLE.wasmHash}')`,
  lookupWallet: `signet.lookupAddress('${EXAMPLE.account}')`,
  resolveHandle: `signet.resolveHandle('${EXAMPLE.handle}')`,
  getRegistryStats: 'signet.getRegistryStats()',
  getHealth: 'signet.getHealth()',
};

export function sdkExample(origin: string, op: ReferenceOperation): string | null {
  const call = SDK_CALLS[op.operationId];
  if (!call) return null;
  return `import { SignetClient } from '@signet/sdk';

const signet = new SignetClient({ baseUrl: '${origin}' });
const result = await ${call};`;
}

/** The success response's documented body as an example, or null for a non-JSON one. */
export function exampleResponse(doc: ApiDocument, op: ReferenceOperation): string | null {
  const ok = op.responses['200'];
  const schema = ok?.content?.['application/json']?.schema;
  if (!schema) return null;
  return JSON.stringify(exampleFor(doc, schema), null, 2);
}

/** The schema a status's JSON body follows, if any. */
export function responseSchema(op: ReferenceOperation, status: string): ApiSchema | undefined {
  return op.responses[status]?.content?.['application/json']?.schema;
}
