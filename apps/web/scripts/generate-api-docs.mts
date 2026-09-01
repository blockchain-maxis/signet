/**
 * Generate API reference documentation from the tRPC router.
 *
 * Usage:
 *   pnpm run docs:generate
 *
 * Output: docs/api-reference.md
 *
 * The route list, procedure type (query/mutation) and auth level are read from
 * the router tree at runtime, so a route can never be missing from the
 * reference. The input/output shapes are hand-written below, because the
 * procedures validate with plain functions rather than a reflectable schema
 * library — swap `docForInput`/`docForOutput` for schema introspection if Zod
 * (or similar) is adopted. Until then, a route with no entry fails the run
 * rather than rendering as "Unknown".
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
  /** `undefined` when the path has no hand-written entry — see `main()`. */
  inputDoc: string | undefined;
  outputDoc: string | undefined;
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
    'registry.resolve':
      '```ts\n{ handle: string }\n```\n' +
      'A well-formed handle: 1–32 chars of `[a-z0-9_-]`. Validated by `handleInput()`.',
    'registry.lookup':
      '```ts\n{ wallet: string }\n```\n' +
      'A Stellar public key (`G…`, 56 chars). Validated by `walletInput()`.',
    'registry.count': 'None',
  };
  return map[path];
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
      '  truncated: boolean;\n' +
      '  cap: number | null;\n' +
      "  source: 'database' | 'horizon' | 'demo' | 'none';\n" +
      '} | null\n```\n' +
      'Profile fields: `name`, `wallet`, `bio`, `joined`. Stats: `invocations`, `uniqueFunctions`, `reputation` (0–100).\n\n' +
      'The operations window is bounded by the layer that answered (`source`). ' +
      'When `truncated` is true the record is partial: `cap` is the limit that ' +
      'cut it short, `operations` holds only the most recent ones, and every ' +
      'count in `stats` is a lower bound rather than a total. Clients must not ' +
      'present a truncated record as a complete one.',
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
    'registry.resolve':
      '```ts\n{ handle: string; wallet: string } | null\n```\n' +
      '`null` when the on-chain directory is unreachable or the handle is unclaimed.',
    'registry.lookup':
      '```ts\n{ handle: string; wallet: string } | null\n```\n' +
      '`null` when the on-chain directory is unreachable or the wallet holds no handle.',
    'registry.count':
      '```ts\n{ count: number | null }\n```\n' +
      "The registry's own binding counter — an upper bound, not a live total (a\n" +
      'binding that archives unaccessed is never subtracted). `null` means the\n' +
      'registry could not be read, which is not the same as zero; the TypeScript\n' +
      "SDK's `countRegistryEntries()` coerces a failed query to `{ count: 0 }`,\n" +
      'so prefer this endpoint where the distinction matters.',
  };
  return map[path];
}

/* ------------------------------------------------------------------ */
/*  Markdown generation                                                */
/* ------------------------------------------------------------------ */

function render(procedures: ProcedureMeta[]): string {
  const lines: string[] = [];

  lines.push('# Signet API Reference');
  lines.push('');
  lines.push(
    'Generated from the tRPC router — do not edit by hand. ' +
      'Regenerate with `pnpm run docs:generate`.',
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  // Sort: health first, then profile.*, account.*, registry.*. Anything not
  // listed sorts last rather than first — `findIndex` returns -1 for unknown
  // categories, which would otherwise float new routers to the top of the page.
  const order = ['health', 'profile', 'account', 'registry'];
  const rank = (path: string) => {
    const i = order.findIndex((o) => path.startsWith(o));
    return i === -1 ? order.length : i;
  };
  const sorted = [...procedures].sort((a, b) => {
    const diff = rank(a.path) - rank(b.path);
    return diff !== 0 ? diff : a.path.localeCompare(b.path);
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

  // The root "health" procedure lives directly on the router, "profile",
  // "account" and "registry" are sub-routers — collectProcedures already
  // recurses into them.
  const documented = procedures.filter(
    (p) => p.path !== 'createCaller' && !p.path.startsWith('_'),
  );

  // The input/output shapes below are maintained by hand, so a procedure added
  // to the router without a matching entry would silently render as "Unknown"
  // and quietly rot the reference. Fail instead: a red `docs:generate` is a
  // one-line fix, a reference full of "Unknown" is not.
  const undocumented = documented.filter((p) => !p.inputDoc || !p.outputDoc);
  if (undocumented.length > 0) {
    console.error(
      `Undocumented procedure(s): ${undocumented.map((p) => p.path).join(', ')}\n` +
        'Add an entry to docForInput() and docForOutput() in this script.',
    );
    process.exit(1);
  }

  writeFileSync(OUT, render(documented), 'utf-8');
  console.log(`Wrote ${OUT} (${documented.length} procedures documented)`);
}

main();
