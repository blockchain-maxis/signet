import type { FunctionSection, LinkedPart } from './function-reference.ts';
import type { TypeEntry } from './type-reference.ts';

function partsText(parts: readonly LinkedPart[]): string {
  return parts.map((p) => p.text).join('');
}

/**
 * Builds a lowercase searchable string for a rendered function section (#479):
 * function name, full signature, argument names, type names, error names, and doc text.
 */
export function functionSearchText(section: FunctionSection): string {
  const tokens: string[] = [
    section.name,
    partsText(section.signature),
    ...section.args.map((arg) => `${arg.name} ${partsText(arg.type)}`),
  ];
  if (section.doc) {
    tokens.push(section.doc);
  }
  if (section.canFail) {
    for (const errEnum of section.canFail.enums) {
      tokens.push(errEnum.name);
      for (const c of errEnum.cases) {
        tokens.push(c.name);
      }
    }
  }
  return tokens.join(' ').toLowerCase();
}

/**
 * Builds a lowercase searchable string for a rendered type section (#479):
 * type name, kind, field/case/variant names, nested type names, and doc text.
 */
export function typeSearchText(entry: TypeEntry): string {
  const tokens: string[] = [entry.name, entry.kind];
  if (entry.doc) {
    tokens.push(entry.doc);
  }
  if (entry.kind === 'struct') {
    for (const f of entry.fields) {
      tokens.push(f.name, partsText(f.type));
      if (f.doc) tokens.push(f.doc);
    }
  } else if (entry.kind === 'union') {
    for (const c of entry.cases) {
      tokens.push(c.name);
      for (const m of c.payload) {
        if (m.name) tokens.push(m.name);
        tokens.push(partsText(m.type));
      }
      if (c.doc) tokens.push(c.doc);
    }
  } else {
    for (const v of entry.variants) {
      tokens.push(v.name, String(v.value));
      if (v.doc) tokens.push(v.doc);
    }
  }
  return tokens.join(' ').toLowerCase();
}

/**
 * Builds a lowercase searchable string for a rendered error table row (#479):
 * error enum name, numeric code, error case name, and doc text.
 */
export function errorRowSearchText(
  enumName: string,
  row: { readonly code: number; readonly name: string; readonly doc: string | null },
): string {
  return `${enumName} ${row.code} ${row.name} ${row.doc ?? ''}`.toLowerCase();
}

/**
 * Case-insensitive substring check against precomputed lowercase search text.
 * Multi-word queries require every whitespace-separated token to match.
 */
export function matchesSearchQuery(searchText: string, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  const hay = searchText.toLowerCase();
  const terms = trimmed.split(/\s+/);
  return terms.every((term) => hay.includes(term));
}

/**
 * Formats the polite live-region announcement for the active filter.
 */
export function formatMatchAnnouncement(matched: number, total: number, noun = 'items'): string {
  return `${matched} of ${total} ${noun} matching`;
}
