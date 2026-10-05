/**
 * @file @signet/spec
 *
 * Build and environment metadata (§1.1 and §3 of docs/CONTRACT_DOCS_DESIGN.md).
 *
 * `contractmetav0` is a bare stream of `ScMetaEntry` values (key/value string
 * pairs written by the Rust toolchain and the SDK) and `contractenvmetav0` a
 * stream of `ScEnvMetaEntry` values (the protocol interface version), both in
 * the same shape as `contractspecv0`. Neither is needed to read the interface,
 * so a section that cannot be decoded is reported, never thrown: the field
 * stays undefined and the reason goes to `warnings`.
 *
 * This is surface only. Nothing here gates on a version (§3).
 *
 * Deliberately no `fetch`, `fs` or `process` here: this runs in the browser as
 * well as Node (`parse.test.ts` enforces it).
 */

import { cereal, xdr } from '@stellar/stellar-sdk';
import type { ContractBuild, ContractEnvMeta } from './types.ts';

/** The custom section carrying the toolchain's key/value build metadata. */
export const CONTRACT_META_SECTION = 'contractmetav0';

/** The custom section carrying the host environment (protocol) version. */
export const CONTRACT_ENV_META_SECTION = 'contractenvmetav0';

/** Keys `ContractBuild` lifts out of `entries`. */
const RUST_VERSION_KEY = 'rsver';
const SDK_VERSION_KEY = 'rssdkver';

/** Fatal so a corrupt value is a decode failure, not mojibake in the docs header. */
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The outcome of reading one section: the value, or the warning explaining its absence. */
export type MetaResult<T> = { readonly value: T } | { readonly warning: string };

/**
 * Decode `contractmetav0` into `ContractBuild`.
 *
 * Every entry lands in `entries` keyed by its name, including keys this
 * package does not know; `rsver` and `rssdkver` are also lifted into
 * `rustVersion` and `sdkVersion`. When a key repeats, the last one wins.
 * `sdkVersion` is the raw value, which is `<version>#<commit hash>` for
 * contracts built by recent SDKs.
 */
export function decodeBuildMeta(section: Uint8Array): MetaResult<ContractBuild> {
  try {
    const pairs = new Map<string, string>();
    for (const entry of readStream(section, xdr.ScMetaEntry)) {
      const meta = entry.v0();
      pairs.set(text(meta.key()), text(meta.val()));
    }
    const rustVersion = pairs.get(RUST_VERSION_KEY);
    const sdkVersion = pairs.get(SDK_VERSION_KEY);
    return {
      value: {
        ...(rustVersion !== undefined ? { rustVersion } : {}),
        ...(sdkVersion !== undefined ? { sdkVersion } : {}),
        // `fromEntries` defines own properties, so a key like `__proto__` stays data.
        entries: Object.fromEntries(pairs),
      },
    };
  } catch (cause) {
    return { warning: `${CONTRACT_META_SECTION} could not be decoded: ${describe(cause)}` };
  }
}

/**
 * Decode `contractenvmetav0` into `ContractEnvMeta`.
 *
 * The only entry kind today is the interface version; the first one wins. A
 * section with none (empty, or only kinds this SDK does not know) is a
 * warning rather than a guess.
 */
export function decodeEnvMeta(section: Uint8Array): MetaResult<ContractEnvMeta> {
  try {
    for (const entry of readStream(section, xdr.ScEnvMetaEntry)) {
      const version = entry.interfaceVersion();
      return { value: { protocolVersion: version.protocol(), preRelease: version.preRelease() } };
    }
    return { warning: `${CONTRACT_ENV_META_SECTION} has no interface version` };
  } catch (cause) {
    return { warning: `${CONTRACT_ENV_META_SECTION} could not be decoded: ${describe(cause)}` };
  }
}

/**
 * Read both meta sections out of a module's custom sections. Never throws:
 * a missing section leaves its field undefined without a warning, a broken one
 * leaves it undefined and adds the reason to `warnings`.
 */
export function readContractMeta(sections: ReadonlyMap<string, readonly Uint8Array[]>): {
  build?: ContractBuild;
  env?: ContractEnvMeta;
  warnings: string[];
} {
  const warnings: string[] = [];
  const read = <T>(name: string, decode: (section: Uint8Array) => MetaResult<T>): T | undefined => {
    const section = sections.get(name)?.[0];
    if (section === undefined) return undefined;
    const result = decode(section);
    if ('warning' in result) {
      warnings.push(result.warning);
      return undefined;
    }
    return result.value;
  };
  const build = read(CONTRACT_META_SECTION, decodeBuildMeta);
  const env = read(CONTRACT_ENV_META_SECTION, decodeEnvMeta);
  return {
    ...(build !== undefined ? { build } : {}),
    ...(env !== undefined ? { env } : {}),
    warnings,
  };
}

/** Read `section` as back-to-back `T` values until the buffer is exhausted. */
function* readStream<T>(
  section: Uint8Array,
  type: { read(reader: InstanceType<typeof cereal.XdrReader>): T },
): Generator<T> {
  const reader = new cereal.XdrReader(Buffer.from(section));
  while (!reader.eof) yield type.read(reader);
}

function text(bytes: Uint8Array | string): string {
  return typeof bytes === 'string' ? bytes : utf8.decode(bytes);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
