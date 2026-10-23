import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateOpenApiSpec } from '../lib/api/v1/openapi.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');
const OUT_FILE = resolve(ROOT, 'docs/api/openapi-v1.json');

/**
 * Deterministically sorts object keys deeply to guarantee stable formatting.
 */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Serializes the OpenAPI specification with sorted keys and stable indentation.
 */
export function formatOpenApiJson(): string {
  const spec = generateOpenApiSpec();
  const sorted = sortKeys(spec);
  return JSON.stringify(sorted, null, 2) + '\n';
}

function main(): void {
  const isCheck = process.argv.includes('--check');
  const formatted = formatOpenApiJson();

  if (isCheck) {
    if (!existsSync(OUT_FILE)) {
      console.error(
        `docs/api/openapi-v1.json does not exist.\nRun 'pnpm --filter @signet/web openapi:export' to generate it.`,
      );
      process.exit(1);
    }

    const current = readFileSync(OUT_FILE, 'utf8');
    if (current !== formatted) {
      console.error(
        `docs/api/openapi-v1.json is stale.\nRun 'pnpm --filter @signet/web openapi:export' to update it.`,
      );
      process.exit(1);
    }

    console.log('docs/api/openapi-v1.json is up to date.');
  } else {
    mkdirSync(dirname(OUT_FILE), { recursive: true });
    writeFileSync(OUT_FILE, formatted, 'utf8');
    console.log('Exported OpenAPI snapshot to docs/api/openapi-v1.json.');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
