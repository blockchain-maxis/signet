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

import { cereal, contract, hash, xdr } from '@stellar/stellar-sdk';
import { readContractMeta } from './meta.ts';
import { InterfaceUnreadable, InvalidWasm, NoInterface } from './errors.ts';
import { STELLAR_SDK_VERSION } from './sdk-version.ts';
import { assertTypeDepth, MAX_TYPE_DEPTH } from './type-ref.ts';
import { buildSpecViews } from './views.ts';
import type { ContractSpec } from './types.ts';
import { readCustomSections } from './wasm-sections.ts';

/** The custom section a Soroban contract publishes its interface in. */
export const CONTRACT_SPEC_SECTION = 'contractspecv0';

/**
 * Default maximum WASM byte size accepted by `parseContractSpec` (256 KB).
 * Soroban's ledger limit on contract code sits well below 256 KB; rejecting
 * larger buffers up front prevents oversized inputs from pinning the parser.
 */
export const MAX_WASM_BYTES = 256 * 1024;

/**
 * Maximum number of `ScSpecEntry` items decoded from a `contractspecv0`
 * section. Real Soroban contracts publish a few dozen entries; capping at
 * 1,024 prevents a synthetic section packed with tiny entries from exhausting
 * CPU time or heap.
 */
export const MAX_SPEC_ENTRIES = 1_024;

/** Options for {@link parseContractSpec}. */
export interface ParseContractSpecOptions {
  /** Override the maximum module byte length (defaults to {@link MAX_WASM_BYTES}). */
  readonly maxBytes?: number;
}

function assertEntryTypeDepth(entry: xdr.ScSpecEntry, maxDepth: number): void {
  switch (entry.switch().name) {
    case 'scSpecEntryFunctionV0': {
      const fn = entry.functionV0();
      for (const input of fn.inputs()) {
        assertTypeDepth(input.type(), maxDepth);
      }
      for (const output of fn.outputs()) {
        assertTypeDepth(output, maxDepth);
      }
      break;
    }
    case 'scSpecEntryUdtStructV0': {
      for (const field of entry.udtStructV0().fields()) {
        assertTypeDepth(field.type(), maxDepth);
      }
      break;
    }
    case 'scSpecEntryUdtUnionV0': {
      for (const c of entry.udtUnionV0().cases()) {
        if (c.switch().name === 'scSpecUdtUnionCaseTupleV0') {
          for (const t of c.tupleCase().type()) {
            assertTypeDepth(t, maxDepth);
          }
        }
      }
      break;
    }
    case 'scSpecEntryEventV0': {
      for (const param of entry.eventV0().params()) {
        assertTypeDepth(param.type(), maxDepth);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Decode the contract interface published in `wasm`'s `contractspecv0`
 * custom section.
 *
 * The section is a bare concatenation of `ScSpecEntry` values with no length
 * prefix, so `ScSpecEntry.fromXDR(section)` fails with "source buffer not
 * entirely consumed". We stream entries with `cereal.XdrReader`, enforcing
 * {@link MAX_SPEC_ENTRIES} and {@link MAX_TYPE_DEPTH} as each entry is read.
 *
 * `functions`, `types` and `errors` are derived from the decoded spec entries.
 * `events` are populated separately. `entries` and `spec` preserve the
 * complete decoded interface.
 *
 * `build` and `env` come from `contractmetav0` and `contractenvmetav0`, which
 * are independent of the spec: each is undefined when its section is missing
 * or cannot be decoded, and a decode failure adds an entry to `warnings`
 * instead of throwing. They are read after the spec, so a module with no
 * interface still throws `NoInterface`.
 *
 * Throws:
 * - `InvalidWasm` — not a WebAssembly module (bad magic/version, framing,
 *   section count, or input over `maxBytes`);
 * - `NoInterface` — `no_section` when there is no `contractspecv0` section,
 *   `empty_section` when it is present but zero bytes long;
 * - `InterfaceUnreadable` — the section is there but cannot be decoded within
 *   entry-count and nesting-depth bounds.
 */
export function parseContractSpec(
  wasm: Uint8Array,
  options?: ParseContractSpecOptions,
): ContractSpec {
  const maxBytes = options?.maxBytes ?? MAX_WASM_BYTES;
  if (wasm.byteLength > maxBytes) {
    throw new InvalidWasm(
      new Error(`module size ${wasm.byteLength} exceeds maximum of ${maxBytes} bytes`),
    );
  }

  const sections = readCustomSections(wasm);
  const section = sections.get(CONTRACT_SPEC_SECTION)?.[0];
  if (!section) throw new NoInterface('no_section');
  if (section.length === 0) throw new NoInterface('empty_section');

  const entries: xdr.ScSpecEntry[] = [];
  let spec: contract.Spec;
  let views: ReturnType<typeof buildSpecViews>;
  try {
    const reader = new cereal.XdrReader(Buffer.from(section));
    while (!reader.eof) {
      if (entries.length >= MAX_SPEC_ENTRIES) {
        throw new RangeError(`contractspecv0 exceeds maximum of ${MAX_SPEC_ENTRIES} entries`);
      }
      const entry = xdr.ScSpecEntry.read(reader);
      assertEntryTypeDepth(entry, MAX_TYPE_DEPTH);
      entries.push(entry);
    }
    spec = new contract.Spec(entries);
    views = buildSpecViews(entries);
  } catch (cause) {
    throw new InterfaceUnreadable(STELLAR_SDK_VERSION, cause);
  }

  const { build, env, warnings } = readContractMeta(sections);

  return {
    // The SDK's hash() is SHA-256, synchronous and isomorphic — unlike
    // WebCrypto's digest, which is async, or node:crypto, which is Node-only.
    wasmHash: hash(Buffer.from(wasm)).toString('hex'),
    entries,
    spec,
    functions: views.functions,
    types: views.types,
    errors: views.errors,
    events: [],
    ...(build !== undefined ? { build } : {}),
    ...(env !== undefined ? { env } : {}),
    warnings,
    sdkVersion: STELLAR_SDK_VERSION,
  };
}
