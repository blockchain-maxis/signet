/**
 * @file Fragment ids for the Functions and Types tabs (#450).
 *
 * One owner for the `#fn-…` / `#type-…` / `#error-…` contract, so the tabs that
 * render the targets (#466, #467, #468) and the links that point at them (the
 * diagram, the Overview, doc-comment cross-references) import the same
 * helpers and cannot disagree about what a shared URL lands on.
 *
 * Soroban identifiers are already `[A-Za-z0-9_]`, so nothing is slugged: the
 * prefix alone keeps a function and a type of the same name apart. Functions
 * live at `…/functions#fn-{name}`; types and errors at `…/types#type-{name}`
 * and `…/types#error-{enum}-{name}`.
 */

/** Fragment id for a function on the Functions tab. */
export function fnAnchor(name: string): string {
  return `fn-${name}`;
}

/** Fragment id for a user-defined type on the Types tab. */
export function typeAnchor(name: string): string {
  return `type-${name}`;
}

/** Fragment id for one error case of an error enum on the Types tab. */
export function errorAnchor(enumName: string, caseName: string): string {
  return `error-${enumName}-${caseName}`;
}
