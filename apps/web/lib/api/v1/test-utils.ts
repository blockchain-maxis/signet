import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { getOpenApiDocument, type OpenApiDocument, type OpenApiOperation } from './openapi.ts';

const DOC_ID = 'https://signet.stellar.org/api/v1/openapi.json';

let cachedAjv: Ajv2020 | null = null;
let cachedDoc: OpenApiDocument | null = null;

function getAjv(doc: OpenApiDocument): Ajv2020 {
  if (cachedAjv && cachedDoc === doc) {
    return cachedAjv;
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', (str: unknown) => typeof str === 'string' && !isNaN(Date.parse(str)));
  ajv.addSchema({ ...doc, $id: DOC_ID });
  cachedAjv = ajv;
  cachedDoc = doc;
  return ajv;
}

function qualifyRefs(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(qualifyRefs);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === '$ref' && typeof v === 'string' && v.startsWith('#/')) {
      out[k] = `${DOC_ID}${v}`;
    } else {
      out[k] = qualifyRefs(v);
    }
  }
  return out;
}

function findOperation(
  doc: OpenApiDocument,
  operationId: string,
): { path: string; method: string; operation: OpenApiOperation } | null {
  for (const [pathKey, pathItem] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(pathItem)) {
      if (
        op &&
        typeof op === 'object' &&
        'operationId' in op &&
        (op as OpenApiOperation).operationId === operationId
      ) {
        return { path: pathKey, method, operation: op as OpenApiOperation };
      }
    }
  }
  return null;
}

/**
 * Asserts that a Response or plain payload matches the schema defined in the OpenAPI 3.1
 * document for the given operationId and HTTP status.
 */
export async function expectMatchesSchema(
  response: Response | unknown,
  operationId: string,
  status?: number,
): Promise<unknown> {
  const doc = getOpenApiDocument();
  const match = findOperation(doc, operationId);
  if (!match) {
    throw new Error(`Operation "${operationId}" not found in OpenAPI specification.`);
  }

  let httpStatus: number;
  let body: unknown;

  if (response instanceof Response) {
    httpStatus = status ?? response.status;
    const text = await response.clone().text();
    body = text ? JSON.parse(text) : null;
  } else {
    httpStatus = status ?? 200;
    body = response;
  }

  const statusStr = String(httpStatus);
  const opResponses = match.operation.responses;
  const responseDef =
    opResponses[statusStr] ??
    opResponses[`${statusStr.charAt(0)}XX`] ??
    opResponses['default'];

  if (!responseDef) {
    throw new Error(
      `No response definition found for status ${httpStatus} in operation "${operationId}".`,
    );
  }

  if (httpStatus === 204 || !responseDef.content) {
    assert.equal(
      body,
      null,
      `Expected empty body for HTTP ${httpStatus} in operation "${operationId}", got ${JSON.stringify(body)}`,
    );
    return body;
  }

  const jsonContent = responseDef.content['application/json'];
  if (!jsonContent || !jsonContent.schema) {
    throw new Error(
      `No application/json schema defined for status ${httpStatus} in operation "${operationId}".`,
    );
  }

  const ajv = getAjv(doc);
  const qualifiedSchema = qualifyRefs(jsonContent.schema) as Record<string, unknown>;
  const validate = ajv.compile(qualifiedSchema);
  const valid = validate(body);

  if (!valid) {
    const errorDetails = (validate.errors ?? [])
      .map((e) => `  - ${e.instancePath || '(root)'}: ${e.message}`)
      .join('\n');
    assert.fail(
      `Response body for operation "${operationId}" (HTTP ${httpStatus}) did not match schema:\n${errorDetails}\nPayload: ${JSON.stringify(body, null, 2)}`,
    );
  }

  return body;
}
