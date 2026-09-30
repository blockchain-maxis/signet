/**
 * @file @signet/spec
 *
 * `parseContractSpec` — the pure half of the reader (§1.2 and §4 of
 * docs/CONTRACT_DOCS_DESIGN.md). It takes WASM bytes and returns the decoded
 * spec, so every consumer's tests run against committed fixtures with no
 * network.
 *
 * Deliberately no `fetch`, `fs` or `process` here: this runs in the browser as
 * well as Node (`parse.test.ts` enforces it).
 */

import { contract, hash, type xdr } from '@stellar/stellar-sdk';
import { InterfaceUnreadable, NoInterface } from './errors.ts';
import { STELLAR_SDK_VERSION } from './sdk-version.ts';
import type { ContractSpec } from './types.ts';
import { readCustomSections } from './wasm-sections.ts';

/** The custom section a Soroban contract publishes its interface in. */
export const CONTRACT_SPEC_SECTION = 'contractspecv0';

/**
 * Decode the contract interface published in `wasm`'s `contractspecv0`
 * custom section.
 *
 * The section is a bare concatenation of `ScSpecEntry` values with no length
 * prefix, so `ScSpecEntry.fromXDR(section)` fails with "source buffer not
 * entirely consumed". `contract.Spec` reads it as a stream instead, one entry
 * after another until the buffer is exhausted.
 *
 * `functions`, `types`, `errors` and `events` are empty until their flattened
 * views land (#430, #431), and `build` is undefined until `contractmetav0` is
 * read (#432). `entries` and `spec` are complete now.
 *
 * Throws:
 * - `InvalidWasm` — not a WebAssembly module (bad magic/version or framing);
 * - `NoInterface` — `no_section` when there is no `contractspecv0` section,
 *   `empty_section` when it is present but zero bytes long;
 * - `InterfaceUnreadable` — the section is there but this SDK cannot decode it.
 */
export function parseContractSpec(wasm: Uint8Array): ContractSpec {
  const sections = readCustomSections(wasm);
  const section = sections.get(CONTRACT_SPEC_SECTION)?.[0];
  if (!section) throw new NoInterface('no_section');
  if (section.length === 0) throw new NoInterface('empty_section');

  let spec: contract.Spec;
  try {
    spec = new contract.Spec(Buffer.from(section));
  } catch (cause) {
    throw new InterfaceUnreadable(STELLAR_SDK_VERSION, cause);
  }

  return {
    // The SDK's hash() is SHA-256, synchronous and isomorphic — unlike
    // WebCrypto's digest, which is async, or node:crypto, which is Node-only.
    wasmHash: hash(Buffer.from(wasm)).toString('hex'),
    entries: spec.entries as readonly xdr.ScSpecEntry[],
    spec,
    functions: [],
    types: [],
    errors: [],
    events: [],
    sdkVersion: STELLAR_SDK_VERSION,
  };
}
