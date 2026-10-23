#!/usr/bin/env node
/**
 * OpenAPI breaking change checker.
 *
 * Compares an OpenAPI 3.1 specification against a baseline snapshot
 * to ensure no breaking changes are introduced to public API v1.
 *
 * Fails on:
 *   - removed path or operation
 *   - removed response property
 *   - changed property type
 *   - new required request parameter
 *   - newly required response field being dropped or added
 *   - removed enum value
 *
 * Per Signet API versioning policy (#624), breaking changes are prohibited on
 * /api/v1. The PR label 'api: breaking' does NOT bypass this check; breaking
 * changes require a new versioned endpoint (/api/v2).
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CURRENT_DOC_PATH = resolve(ROOT, 'docs/api/openapi-v1.json');

/**
 * Resolves a JSON Pointer ($ref) within an OpenAPI document.
 */
export function resolveRef(doc, ref) {
  if (!ref || typeof ref !== 'string' || !ref.startsWith('#/')) {
    return null;
  }
  const parts = ref.slice(2).split('/');
  let current = doc;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = current[part];
    } else {
      return null;
    }
  }
  return current;
}

function normalizeType(type) {
  if (Array.isArray(type)) {
    return [...type].sort().join('|');
  }
  return type ?? '';
}

/**
 * Deeply compares two JSON schemas and appends breaking changes to the errors array.
 */
export function compareSchemas(
  baseSchema,
  headSchema,
  context,
  errors,
  baseDoc,
  headDoc,
  seen = new Set(),
) {
  if (!baseSchema || !headSchema) return;

  // Prevent circular loops
  const pairKey = `${baseSchema.$ref || JSON.stringify(baseSchema)}<=>${headSchema.$ref || JSON.stringify(headSchema)}@${context}`;
  if (seen.has(pairKey)) return;
  seen.add(pairKey);

  let derefBase = baseSchema;
  let derefHead = headSchema;

  if (baseSchema.$ref && (!headSchema.$ref || baseSchema.$ref !== headSchema.$ref)) {
    derefBase = resolveRef(baseDoc, baseSchema.$ref) || baseSchema;
  }
  if (headSchema.$ref && (!baseSchema.$ref || baseSchema.$ref !== headSchema.$ref)) {
    derefHead = resolveRef(headDoc, headSchema.$ref) || headSchema;
  }

  // 1. Check property type change
  if (derefBase.type !== undefined && derefHead.type !== undefined) {
    const normBase = normalizeType(derefBase.type);
    const normHead = normalizeType(derefHead.type);
    if (normBase !== normHead) {
      errors.push(
        `Changed property type at ${context}: was ${JSON.stringify(derefBase.type)}, now ${JSON.stringify(derefHead.type)}`,
      );
    }
  }

  // 2. Check removed enum values
  if (Array.isArray(derefBase.enum)) {
    if (!Array.isArray(derefHead.enum)) {
      errors.push(`Removed enum at ${context}`);
    } else {
      for (const val of derefBase.enum) {
        if (!derefHead.enum.includes(val)) {
          errors.push(`Removed enum value "${val}" at ${context}`);
        }
      }
    }
  }

  // 3. Check response properties (removed properties)
  if (derefBase.properties && typeof derefBase.properties === 'object') {
    const headProps =
      derefHead.properties && typeof derefHead.properties === 'object' ? derefHead.properties : {};
    for (const [propName, baseProp] of Object.entries(derefBase.properties)) {
      if (!(propName in headProps)) {
        errors.push(`Removed response property "${propName}" at ${context}`);
      } else {
        compareSchemas(
          baseProp,
          headProps[propName],
          `${context}.${propName}`,
          errors,
          baseDoc,
          headDoc,
          seen,
        );
      }
    }
  }

  // 4. Check required response fields:
  // - A field required in base dropped from head properties or from head required
  // - A newly required response field introduced in head
  if (Array.isArray(derefBase.required)) {
    for (const field of derefBase.required) {
      if (derefHead.properties && !(field in derefHead.properties)) {
        errors.push(`Required response field "${field}" dropped at ${context}`);
      } else if (Array.isArray(derefHead.required) && !derefHead.required.includes(field)) {
        errors.push(`Required response field "${field}" dropped from required at ${context}`);
      }
    }
  }

  if (Array.isArray(derefHead.required)) {
    const baseRequired = Array.isArray(derefBase.required) ? derefBase.required : [];
    for (const field of derefHead.required) {
      if (!baseRequired.includes(field)) {
        errors.push(`Newly required response field "${field}" at ${context}`);
      }
    }
  }

  // 5. Array items
  if (derefBase.items && derefHead.items) {
    compareSchemas(
      derefBase.items,
      derefHead.items,
      `${context}[]`,
      errors,
      baseDoc,
      headDoc,
      seen,
    );
  }
}

/**
 * Inspects two OpenAPI specification documents and returns an array of breaking change descriptions.
 */
export function findBreakingChanges(baseDoc, headDoc) {
  const errors = [];
  const seen = new Set();

  if (!baseDoc || !headDoc) {
    return ['Invalid document provided for comparison'];
  }

  const basePaths = baseDoc.paths || {};
  const headPaths = headDoc.paths || {};
  const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'];

  // Check paths and operations
  for (const [pathKey, basePathItem] of Object.entries(basePaths)) {
    if (!(pathKey in headPaths)) {
      errors.push(`Removed path "${pathKey}"`);
      continue;
    }

    const headPathItem = headPaths[pathKey] || {};

    for (const method of httpMethods) {
      if (basePathItem[method]) {
        if (!headPathItem[method]) {
          errors.push(`Removed operation ${method.toUpperCase()} ${pathKey}`);
          continue;
        }

        const baseOp = basePathItem[method];
        const headOp = headPathItem[method];

        // Check request parameters
        const baseParams = new Map();
        for (const p of baseOp.parameters || []) {
          baseParams.set(`${p.in}:${p.name}`, p);
        }

        for (const headP of headOp.parameters || []) {
          const key = `${headP.in}:${headP.name}`;
          const baseP = baseParams.get(key);

          if (headP.required) {
            if (!baseP) {
              errors.push(
                `New required request parameter "${headP.name}" in ${headP.in} for ${method.toUpperCase()} ${pathKey}`,
              );
            } else if (!baseP.required) {
              errors.push(
                `Request parameter "${headP.name}" in ${headP.in} became required for ${method.toUpperCase()} ${pathKey}`,
              );
            }
          }
        }

        // Check responses
        const baseResponses = baseOp.responses || {};
        const headResponses = headOp.responses || {};

        for (const [statusCode, baseResp] of Object.entries(baseResponses)) {
          if (!(statusCode in headResponses)) {
            errors.push(
              `Removed response status ${statusCode} for ${method.toUpperCase()} ${pathKey}`,
            );
            continue;
          }

          const headResp = headResponses[statusCode] || {};
          if (baseResp.content) {
            for (const [mediaType, baseMedia] of Object.entries(baseResp.content)) {
              if (!headResp.content || !(mediaType in headResp.content)) {
                errors.push(
                  `Removed response media type "${mediaType}" for ${statusCode} ${method.toUpperCase()} ${pathKey}`,
                );
                continue;
              }

              const headMedia = headResp.content[mediaType];
              if (baseMedia.schema && headMedia?.schema) {
                compareSchemas(
                  baseMedia.schema,
                  headMedia.schema,
                  `${method.toUpperCase()} ${pathKey} [${statusCode}]`,
                  errors,
                  baseDoc,
                  headDoc,
                  seen,
                );
              }
            }
          }
        }
      }
    }
  }

  // Check component schemas
  const baseSchemas = baseDoc.components?.schemas || {};
  const headSchemas = headDoc.components?.schemas || {};

  for (const [name, baseSchema] of Object.entries(baseSchemas)) {
    if (!(name in headSchemas)) {
      errors.push(`Removed component schema "${name}"`);
    } else {
      compareSchemas(
        baseSchema,
        headSchemas[name],
        `components.schemas.${name}`,
        errors,
        baseDoc,
        headDoc,
        seen,
      );
    }
  }

  return errors;
}

function getBaseSnapshot() {
  const candidateRefs = [
    'origin/main:docs/api/openapi-v1.json',
    'upstream/main:docs/api/openapi-v1.json',
    'main:docs/api/openapi-v1.json',
    'HEAD~1:docs/api/openapi-v1.json',
  ];

  for (const ref of candidateRefs) {
    try {
      const content = execSync(`git show ${ref}`, {
        stdio: ['pipe', 'pipe', 'ignore'],
        encoding: 'utf8',
      });
      if (content.trim()) {
        return JSON.parse(content);
      }
    } catch {
      // Continue to next ref
    }
  }

  // Attempt shallow fetch of origin/main if not found
  try {
    execSync('git fetch origin main --depth=1', { stdio: 'ignore' });
    const content = execSync('git show origin/main:docs/api/openapi-v1.json', {
      stdio: ['pipe', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    if (content.trim()) {
      return JSON.parse(content);
    }
  } catch {
    // Continue
  }

  return null;
}

export function main() {
  const args = process.argv.slice(2);
  let baseDoc;
  let headDoc;

  if (args.length >= 2) {
    baseDoc = JSON.parse(readFileSync(resolve(args[0]), 'utf8'));
    headDoc = JSON.parse(readFileSync(resolve(args[1]), 'utf8'));
  } else {
    baseDoc = getBaseSnapshot();
    if (!baseDoc) {
      console.log(
        'No baseline OpenAPI snapshot found on main (initial snapshot). Skipping breaking change check.',
      );
      process.exit(0);
    }

    if (!existsSync(CURRENT_DOC_PATH)) {
      console.error(`Current OpenAPI document not found at ${CURRENT_DOC_PATH}`);
      process.exit(1);
    }

    headDoc = JSON.parse(readFileSync(CURRENT_DOC_PATH, 'utf8'));
  }

  const breakingChanges = findBreakingChanges(baseDoc, headDoc);

  if (breakingChanges.length > 0) {
    console.error('OpenAPI breaking changes detected on /api/v1:');
    for (const change of breakingChanges) {
      console.error(`  - ${change}`);
    }
    console.error(
      '\nBreaking changes are prohibited on v1. Introduce /api/v2 for breaking modifications.',
    );
    process.exit(1);
  }

  console.log('No breaking changes detected in OpenAPI specification.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
