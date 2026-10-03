/**
 * @file @signet/spec
 *
 * Shared reader and parser for on-chain Soroban contract specifications.
 *
 * Package Contract (§5 of docs/CONTRACT_DOCS_DESIGN.md):
 * - Read-only: fetches and decodes contract specifications from ledger entries/WASM custom sections.
 * - No rendering: does not generate HTML, UI components, or presentation markup.
 * - No execution: does not execute Soroban contracts, emulate VM semantics, or invoke host functions.
 * - Nothing protocol-version-gated: does not enforce execution constraints or protocol version fences.
 */

export const SPEC_READER_VERSION = '0.1.0';

export * from './types.ts';
export * from './errors.ts';
export * from './json.ts';
export * from './type-ref.ts';
export * from './cache/index.ts';
export * from './views.ts';
export * from './closure.ts';
export * from './xdr-text.ts';
export { parseContractSpec, CONTRACT_SPEC_SECTION } from './parse.ts';
export { readCustomSections } from './wasm-sections.ts';
export { STELLAR_SDK_VERSION } from './sdk-version.ts';
export * from './events.ts';
