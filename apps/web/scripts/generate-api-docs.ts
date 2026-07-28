/**
 * Generate API reference documentation from the tRPC router.
 *
 * Usage:
 *   tsx apps/web/scripts/generate-api-docs.ts
 *
 * Output: docs/api-reference.md
 *
 * This script introspects the router tree at runtime and emits a markdown
 * reference.  Input/output shapes are documented based on the known input
 * validators and return types — if schemas (Zod etc.) are added later this
 * script can be extended to derive them automatically.
 */

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { appRouter } from '../lib/server/trpc.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../../../docs/api-reference.md');

/* ------------------------------------------------------------------ */
/*  Router introspection                                               */
/* ------------------------------------------------------------------ */

type ProcedureMeta = {
  path: string;
  type: 'query' | 'mutation';
  auth: 'public' | 'protected';
  inputDoc: string;
  outputDoc: string;
};

/**
 * Walk a router tree recursively and collect all leaf procedures together with
 * their middleware chain (to determine whether the procedure is public or
 * protected).
 */
function collectProcedures(
  router: Record<string, unknown>,
  prefix: string,
): ProcedureMeta[] {
  const results: ProcedureMeta[] = [];

  for (const [key, value] of Object.entries(router)) {
    if (key === '_def' || key === 'createCaller') continue;
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const val = value as Record<string, unknown>;

    // Check if this is a procedure (has _def), a sub-router, or a caller.
    if (val?._def && typeof val._def === 'object') {
      const def = val._def as Record<string, unknown>;

      // Determine procedure type.
      if (def.type === 'query' || def.type === 'mutation') {
        // Determine auth level by inspecting the middleware chain.
        const auth: 'public' | 'protected' = computeAuth(val);
        results.push({
          path: fullPath,
          type: def.type as 'query' | 'mutation',
          auth,
          inputDoc: docForInput(fullPath),
          outputDoc: docForOutput(fullPath),
        });
      }
    }

    // Recurse into nested routers (sub-routers).
    if (val && typeof val === 'object' && !val._def) {
      const nested = collectProcedures(val, fullPath);
      results.push(...nested);
    }
  }

  return results;
}

/**
 * Walk up the middleware / untypedProcedure chain to determine if this
 * procedure goes through `publicProcedure` or `protectedProcedure`.
 */
function computeAuth(procedure: Record<string, unknown>): 'public' | 'protected' {
  // Walk the procedure's _internal representation — try a few known shapes.
  const seen = new Set<unknown>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function walk(obj: any): 'public' | 'protected' | null {
    if (!obj || seen.has(obj)) return null;
    seen.add(obj);

    // Check for auth marker by inspecting the middleware pipeline.
    if (obj._def?.middlewares && Array.isArray(obj._def.middlewares)) {
      // Serialise each middleware source to detect the "Unauthorized" / session check.
      for (const mw of obj._def.middlewares) {
        const src = mw?.toString() ?? '';
        if (src.includes('sessionAddress') || src.includes('address')) {
          return 'protected';
        }
      }
    }

    // Walk parent references.
    if (obj._def?._def) {
      const res = walk(obj._def._def);
      if (res) return res;
    }
    // Try the procedure builder reference.
    if (obj._def?.procedure) {
      const res = walk(obj._def.procedure);
      if (res) return res;
    }

    return null;
  }

  return walk(procedure) ?? 'public';
}

/**
 * Manual input documentation — kept in sync with the actual input validators
 * defined in the codebase (handleInput, normalizeAccountUpdate).
 */
function docForInput(path: string): string {
  const map: Record<string, string> = {
    'health': 'None',
    'profile.list': 'None',
    'profile.byHandle':
      '```ts\n{ handle: string }\n```\n' +
      'A well-formed handle: 1–32 chars of `[a-z0-9_-]`. Validated by `handleInput()`.',
    'account.me': 'None (session cookie carries the identity)',
    'account.update':
      '```ts\n{ displayName: string | null; bio: string | null }\n```\n' +
      '`displayName`: max 80 chars. `bio`: max 280 chars. Validated by `normalizeAccountUpdate()`.',
  };
  return map[path] ?? 'Unknown';
}

/**
 * Manual output documentation — kept in sync with the actual return types.
 */
function docForOutput(path: string): string {
  const map: Record<string, string> = {
    'health':
      '```ts\n{ ok: true; service: "signet"; ts: number }\n```',
    'profile.list':
      '```ts\nstring[]\n```\nArray of all registered handles.',
    'profile.byHandle':
      '```ts\n{\n' +
      '  handle: string;\n' +
      '  profile: Profile;\n' +
      '  stats: ProfileStats;\n' +
      '  operations: Operation[];\n' +
      '} | null\n```\n' +
      'Profile fields: `name`, `wallet`, `bio`, `joined`. Stats: `invocations`, `uniqueFunctions`, `reputation` (0–100).',
    'account.me':
      '```ts\n{\n' +
      '  address: string;\n' +
      '  handle: string | null;\n' +
      '  displayName: string | null;\n' +
      '  bio: string | null;\n' +
      '}\n```',
    'account.update':
      '```ts\n{\n' +
      '  address: string;\n' +
      '  handle: string | null;\n' +
      '  displayName: string | null;\n' +
      '  bio: string | null;\n' +
      '}\n```',
  };
  return map[path] ?? 'Unknown';
}

/* ------------------------------------------------------------------ */
/*  Markdown generation                                                */
/* ------------------------------------------------------------------ */

function render(procedures: ProcedureMeta[]): string {
  const lines: string[] = [];

  lines.push('# Signet API Reference');
  lines.push('');
  lines.push(
    'Auto-generated from the tRPC router.  Regenerate with: `pnpm run docs:generate`',
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  // Sort: health first, then profile.*, then account.*
  const sorted = [...procedures].sort((a, b) => {
    const order = ['health', 'profile', 'account'];
    const aCat = order.findIndex((o) => a.path.startsWith(o));
    const bCat = order.findIndex((o) => b.path.startsWith(o));
    if (aCat !== bCat) return aCat - bCat;
    return a.path.localeCompare(b.path);
  });

  for (const p of sorted) {
    lines.push(`## \`${p.path}\``);
    lines.push('');
    lines.push(`- **Type:** \`${p.type}\``);
    lines.push(`- **Auth:** \`${p.auth}\``);
    lines.push('');

    lines.push('### Input');
    lines.push('');
    lines.push(p.inputDoc);
    lines.push('');

    lines.push('### Output');
    lines.push('');
    lines.push(p.outputDoc);
    lines.push('');

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Main                                                                */
/* ------------------------------------------------------------------ */

function main() {
  // The appRouter is a TRPCRouter.  Enumerate its keys.
  const router = appRouter as unknown as Record<string, unknown>;
  const procedures = collectProcedures(router, '');

  // The root "health" procedure lives directly on the router, "profile" and
  // "account" are sub-routers — collectProcedures already recurses into them.
  const md = render(
    procedures.filter((p) => p.path !== 'createCaller' && !p.path.startsWith('_')),
  );

  writeFileSync(OUT, md, 'utf-8');
  console.log(`Wrote ${OUT} (${procedures.length} procedures documented)`);
}

main();
