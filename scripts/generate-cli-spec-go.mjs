#!/usr/bin/env node
// Regenerates cli/internal/spec/zz_generated_api.go from the CLI wire contract
// in packages/types/src/cli-api.ts, so the Go CLI decodes the same request and
// response shapes, and branches on the same failure codes, as the routes that
// produce them.
//
// Run this after changing cli-api.ts. CI (scripts/check-cli-spec-go.mjs)
// fails the build if the checked-in .go file drifts from what this would
// produce.
//
// Like generate-wallet-source-go.mjs, this is not a TypeScript parser. It
// accepts a deliberately small subset — string-literal unions and flat
// interfaces, described at the top of cli-api.ts — and fails loudly on
// anything else, so a construct it doesn't understand can never be silently
// dropped from the Go side.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
export const tsPath = resolve(root, 'packages/types/src/cli-api.ts');
export const goPath = resolve(root, 'cli/internal/spec/zz_generated_api.go');

class SpecError extends Error {}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PRIMITIVES = { string: 'string', boolean: 'bool', number: 'float64' };

/**
 * Parse cli-api.ts into `{ decls }`, where each decl is either
 * `{ kind: 'union', name, members }` (members already flattened to string
 * literals) or `{ kind: 'interface', name, fields }`. Throws SpecError on
 * anything outside the supported subset.
 */
export function parseCliApi(source) {
  const code = source
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  const decls = [];
  const statement =
    /export\s+type\s+(\w+)\s*=\s*([^;]+);|export\s+interface\s+(\w+)\s*\{([^}]*)\}/g;
  let cursor = 0;
  let m;
  while ((m = statement.exec(code))) {
    const between = code.slice(cursor, m.index);
    if (between.trim() !== '') {
      throw new SpecError(`unsupported TypeScript: ${JSON.stringify(between.trim().slice(0, 80))}`);
    }
    cursor = statement.lastIndex;
    if (m[1]) decls.push({ kind: 'union', name: m[1], raw: m[2] });
    else decls.push({ kind: 'interface', name: m[3], raw: m[4] });
  }
  const rest = code.slice(cursor);
  if (rest.trim() !== '') {
    throw new SpecError(`unsupported TypeScript: ${JSON.stringify(rest.trim().slice(0, 80))}`);
  }

  const names = new Set();
  for (const d of decls) {
    if (names.has(d.name)) throw new SpecError(`${d.name} is declared twice`);
    names.add(d.name);
  }

  // Unions first, so interfaces can refer to them and unions to each other
  // regardless of declaration order.
  const rawUnions = new Map(decls.filter((d) => d.kind === 'union').map((d) => [d.name, d.raw]));
  const resolved = new Map();
  const resolveUnion = (name, stack = []) => {
    if (resolved.has(name)) return resolved.get(name);
    if (stack.includes(name)) throw new SpecError(`union ${name} refers to itself`);
    const members = [];
    for (const part of rawUnions
      .get(name)
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const literal = part.match(/^'([a-z0-9-]+)'$/);
      if (literal) {
        members.push(literal[1]);
      } else if (IDENT.test(part) && rawUnions.has(part)) {
        members.push(...resolveUnion(part, [...stack, name]));
      } else {
        throw new SpecError(
          `union ${name}: unsupported member ${JSON.stringify(part)} ` +
            "(expected a 'kebab-case' string literal or another union declared in this file)",
        );
      }
    }
    const unique = [...new Set(members)];
    if (unique.length === 0) throw new SpecError(`union ${name} has no members`);
    resolved.set(name, unique);
    return unique;
  };

  for (const d of decls) {
    if (d.kind === 'union') {
      d.members = resolveUnion(d.name);
      continue;
    }
    d.fields = d.raw
      .split(/[;\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const field = line.match(/^(\w+)(\?)?\s*:\s*(.+)$/);
        if (!field)
          throw new SpecError(`interface ${d.name}: unsupported member ${JSON.stringify(line)}`);
        const [, name, optional, type] = field;
        return {
          name,
          optional: Boolean(optional),
          goType: goFieldType(d.name, name, type.trim(), rawUnions),
        };
      });
    if (d.fields.length === 0) throw new SpecError(`interface ${d.name} has no fields`);
  }

  return { decls: decls.map(({ raw: _raw, ...rest }) => rest) };
}

function goFieldType(iface, field, type, unions) {
  const parts = type.split('|').map((s) => s.trim());
  // `string | null` decodes JSON null to "", which is how the CLI already
  // treats "no handle" — a pointer would only move that check around.
  if (parts.length === 2 && parts.includes('string') && parts.includes('null')) return 'string';
  if (parts.length === 1) {
    if (PRIMITIVES[type]) return PRIMITIVES[type];
    if (unions.has(type)) return type;
  }
  throw new SpecError(
    `interface ${iface}.${field}: unsupported type ${JSON.stringify(type)} ` +
      '(expected string, boolean, number, string | null, or a union declared in this file)',
  );
}

// ── rendering ───────────────────────────────────────────────────────────────

/** Go initialisms, so generated names read the way hand-written Go would. */
const INITIALISMS = new Set(['ok', 'id', 'url', 'xdr', 'json', 'http']);

function pascal(words) {
  return words
    .filter(Boolean)
    .map((w) =>
      INITIALISMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1),
    )
    .join('');
}

/** `network_passphrase` → NetworkPassphrase, `publicKey` → PublicKey, `ok` → OK. */
export function goFieldName(name) {
  return pascal(name.split('_'));
}

/** `wallet-bound-elsewhere` under CompleteFailure → CompleteFailureWalletBoundElsewhere. */
export function goConstName(typeName, value) {
  return typeName + pascal(value.split('-'));
}

function plural(name) {
  return name.endsWith('s') ? `${name}es` : `${name}s`;
}

/**
 * Pad rows of cells so they line up the way gofmt aligns them (a single space
 * between columns, padded to the widest cell). Getting this right here is what
 * keeps `gofmt -l` quiet on generated output.
 */
function align(rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      if (i < row.length - 1) widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row.map((cell, i) => (i < row.length - 1 ? cell.padEnd(widths[i]) : cell)).join(' '),
  );
}

function renderUnion({ name, members }) {
  const consts = align(members.map((v) => [goConstName(name, v), name, `= "${v}"`]));
  return `// ${name} mirrors the ${name} union in packages/types/src/cli-api.ts.
type ${name} string

const (
${consts.map((l) => `\t${l}`).join('\n')}
)

// ${plural(name)} lists every ${name} value, in declaration order.
var ${plural(name)} = []${name}{
${members.map((v) => `\t${goConstName(name, v)},`).join('\n')}
}
`;
}

function renderInterface({ name, fields }) {
  const rows = align(
    fields.map((f) => [
      goFieldName(f.name),
      f.goType,
      `\`json:"${f.name}${f.optional ? ',omitempty' : ''}"\``,
    ]),
  );
  return `// ${name} mirrors the ${name} interface in packages/types/src/cli-api.ts.
type ${name} struct {
${rows.map((l) => `\t${l}`).join('\n')}
}
`;
}

export function renderGo({ decls }) {
  const body = decls
    .map((d) => (d.kind === 'union' ? renderUnion(d) : renderInterface(d)))
    .join('\n');
  return `// Code generated by scripts/generate-cli-spec-go.mjs from
// packages/types/src/cli-api.ts. DO NOT EDIT by hand — change the TypeScript
// source of truth and regenerate instead.

package spec

${body}`;
}

/** Read cli-api.ts and render it, exiting with a readable message on a SpecError. */
export async function generate() {
  const source = await readFile(tsPath, 'utf8');
  try {
    return renderGo(parseCliApi(source));
  } catch (err) {
    if (err instanceof SpecError) {
      console.error(`${tsPath.slice(root.length + 1)}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const go = await generate();
  await writeFile(goPath, go);
  console.log(`Wrote ${goPath.slice(root.length + 1)}.`);
}
