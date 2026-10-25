/**
 * @file The conformance corpus (#547): what the shared TS spec reader says,
 * for the host to agree with.
 *
 *   node --experimental-strip-types sandbox/conformance/generate.mts          # write corpus.json
 *   node --experimental-strip-types sandbox/conformance/generate.mts --check  # fail if it is stale
 *
 * There is one spec reader. The host has to interpret a contract's spec to
 * run it, so its reading is pinned to the shared reader's here: for every
 * fixture WASM this records
 *
 * - the reader's SpecJson, `canonicalStringify(toSpecJson(parseContractSpec(wasm)))`
 *   (#434), which the host's `spec_extract` must equal field for field;
 * - per function, JSON argument values in `functionArgsSchema`'s shape, valid
 *   and invalid, with what the SDK's `contract.Spec` (the reader's encoder)
 *   makes of each: the `ScVal` XDR, or a refusal. The host's
 *   `spec_encode_args` must produce the same bytes and the same verdict.
 *
 * `sandbox/simulator/tests/conformance.rs` replays the corpus through the
 * host. Deliberate differences are listed in `KNOWN_DIFFERENCES.md`.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalStringify,
  parseContractSpec,
  toSpecJson,
  type ContractSpec,
  type SpecField,
  type TypeRef,
} from '../../packages/spec/src/index.ts';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

/** The SDK's spec, as `@signet/spec` resolves it: the reader's own encoder. */
interface SdkSpec {
  funcArgsToScVals(fn: string, args: object): { toXDR(format: 'base64'): string }[];
}
const { contract } = createRequire(join(root, 'packages', 'spec', 'package.json'))(
  '@stellar/stellar-sdk',
) as {
  contract: { Spec: new (entries: string[]) => SdkSpec };
};
const CORPUS = join(here, 'corpus.json');

/** Every fixture WASM with a spec: the shared reader's own, and #529's. */
function fixtures(): string[] {
  const dirs = [
    join(root, 'packages', 'spec', 'fixtures'),
    join(root, 'sandbox', 'fixtures', 'wasm'),
  ];
  const skip = new Set(['no_spec.wasm', 'corrupt_section.wasm']);
  return dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.wasm') && !skip.has(f))
      .sort()
      .map((f) => join(dir, f)),
  );
}

const G_ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const C_ADDRESS = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';

/**
 * A valid JSON value for a type, in `functionArgsSchema`'s shape: 64-bit and
 * wider integers as decimal strings, bytes as base64, addresses as strkeys,
 * maps as `[key, value]` pairs, unions as `{ tag, values }`. `variant`
 * varies the value, so a function gets more than one valid case.
 */
function valueOf(type: TypeRef, spec: ContractSpec, variant: number, depth = 0): unknown {
  if (depth > 6) throw new Error('type too deep for the corpus');
  if (typeof type === 'string') {
    switch (type) {
      case 'bool':
        return variant % 2 === 0;
      case 'u32':
        return variant === 0 ? 7 : 4_294_967_295;
      case 'i32':
        return variant === 0 ? -7 : 2_147_483_647;
      case 'u64':
      case 'timepoint':
      case 'duration':
        return variant === 0 ? '1700000000' : '18446744073709551615';
      case 'i64':
        return variant === 0 ? '-42' : '9223372036854775807';
      case 'u128':
        return variant === 0 ? '1000000000000000000000' : '340282366920938463463374607431768211455';
      case 'i128':
        return variant === 0
          ? '-1000000000000000000000'
          : '170141183460469231731687303715884105727';
      case 'u256':
        return variant === 0 ? '12345678901234567890123456789' : '0';
      case 'i256':
        return variant === 0 ? '-12345678901234567890123456789' : '0';
      case 'string':
        return variant === 0 ? 'hello' : 'héllo wörld';
      case 'symbol':
        return variant === 0 ? 'sym' : 'a_longer_symbol';
      case 'bytes':
        return variant === 0 ? 'AQID' : '';
      case 'address':
        return variant === 0 ? G_ADDRESS : C_ADDRESS;
      case 'void':
        return null;
      default:
        throw new Error(`no corpus value for ${type}`);
    }
  }
  switch (type.type) {
    case 'bytes_n':
      return Buffer.alloc(type.n, variant + 1).toString('base64');
    case 'option':
      return variant === 0 ? valueOf(type.value, spec, variant, depth + 1) : null;
    case 'vec':
      return variant === 0
        ? [valueOf(type.element, spec, 0, depth + 1), valueOf(type.element, spec, 1, depth + 1)]
        : [];
    case 'map':
      return variant === 0
        ? [[valueOf(type.key, spec, 0, depth + 1), valueOf(type.value, spec, 0, depth + 1)]]
        : [];
    case 'tuple':
      return type.elements.map((e) => valueOf(e, spec, variant, depth + 1));
    case 'named':
      return namedValue(type.name, spec, variant, depth);
    default:
      throw new Error(`no corpus value for ${JSON.stringify(type)}`);
  }
}

function namedValue(name: string, spec: ContractSpec, variant: number, depth: number): unknown {
  const t = spec.types.find((x) => x.name === name);
  if (!t) throw new Error(`type ${name} is not in the spec`);
  switch (t.kind) {
    case 'struct': {
      const tupleStruct = t.fields.length > 0 && t.fields.every((f) => /^\d+$/.test(f.name));
      if (tupleStruct) return t.fields.map((f) => valueOf(f.type, spec, variant, depth + 1));
      return Object.fromEntries(
        t.fields.map((f) => [f.name, valueOf(f.type, spec, variant, depth + 1)]),
      );
    }
    case 'union': {
      const c = t.cases[variant % t.cases.length]!;
      return c.fields.length === 0
        ? { tag: c.name }
        : { tag: c.name, values: c.fields.map((f) => valueOf(f.type, spec, variant, depth + 1)) };
    }
    case 'enum':
      return t.variants[variant % t.variants.length]!.value;
    default:
      throw new Error(`no corpus value for ${t.kind} ${name}`);
  }
}

/** A value of the wrong shape for the type: what a typo or a stale UI sends. */
function wrongValueOf(type: TypeRef): unknown {
  if (typeof type === 'string') {
    switch (type) {
      case 'bool':
        return 'yes';
      case 'u32':
        return 4_294_967_296;
      case 'i32':
        return 'seven';
      case 'string':
      case 'symbol':
      case 'address':
        return 5;
      default:
        return { not: 'this' };
    }
  }
  return type.type === 'option' ? wrongValueOf(type.value) : 42;
}

interface Case {
  readonly name: string;
  readonly function: string;
  readonly args: Record<string, unknown>;
  /** What the shared reader's encoder makes of it. */
  readonly expected:
    | { readonly ok: true; readonly argsXdr: string[] }
    | { readonly ok: false; readonly reason: string };
}

function encode(sdkSpec: SdkSpec, fn: string, args: Record<string, unknown>): Case['expected'] {
  try {
    // The SDK reads 64-bit and wider integers from strings, bytes from
    // Buffers; the JSON shape carries bytes as base64, so they go in as such.
    const argsXdr = sdkSpec.funcArgsToScVals(fn, args).map((v) => v.toXDR('base64'));
    return { ok: true, argsXdr };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function casesFor(spec: ContractSpec): Case[] {
  const sdkSpec = new contract.Spec(spec.entries.map((e) => e.toXDR('base64') as string));
  const cases: Case[] = [];
  for (const fn of spec.functions) {
    const tryValues = (variant: number): Record<string, unknown> | null => {
      try {
        return Object.fromEntries(
          fn.inputs.map((i: SpecField) => [i.name, valueOf(i.type, spec, variant)]),
        );
      } catch {
        return null;
      }
    };
    for (const variant of [0, 1]) {
      const args = tryValues(variant);
      if (args === null) continue;
      cases.push({
        name: `${fn.name} valid ${variant}`,
        function: fn.name,
        args,
        expected: encode(sdkSpec, fn.name, args),
      });
    }
    const base = tryValues(0);
    if (base === null) continue;
    for (const input of fn.inputs) {
      const args = { ...base, [input.name]: wrongValueOf(input.type) };
      cases.push({
        name: `${fn.name} wrong ${input.name}`,
        function: fn.name,
        args,
        expected: encode(sdkSpec, fn.name, args),
      });
    }
    const required = fn.inputs.find(
      (i) => !(typeof i.type === 'object' && i.type.type === 'option'),
    );
    if (required) {
      const { [required.name]: _dropped, ...rest } = base;
      cases.push({
        name: `${fn.name} missing ${required.name}`,
        function: fn.name,
        args: rest,
        expected: encode(sdkSpec, fn.name, rest),
      });
    }
  }
  return cases;
}

function corpus(): string {
  const entries = fixtures().map((path) => {
    const wasm = readFileSync(path);
    const spec = parseContractSpec(wasm);
    return {
      fixture: relative(root, path),
      name: basename(path, '.wasm'),
      wasmHash: createHash('sha256').update(wasm).digest('hex'),
      specJson: JSON.parse(canonicalStringify(toSpecJson(spec))),
      cases: casesFor(spec),
    };
  });
  return `${JSON.stringify({ version: 1, generatedBy: 'sandbox/conformance/generate.mts', fixtures: entries }, null, 2)}\n`;
}

const text = corpus();
if (process.argv.includes('--check')) {
  let committed = '';
  try {
    committed = readFileSync(CORPUS, 'utf8');
  } catch {
    // missing: reported below
  }
  if (committed !== text) {
    console.error(
      'sandbox/conformance/corpus.json is stale against the shared spec reader.\n' +
        'Regenerate it: node --experimental-strip-types sandbox/conformance/generate.mts',
    );
    process.exit(1);
  }
  console.log('sandbox/conformance/corpus.json is up to date.');
} else {
  writeFileSync(CORPUS, text);
  const parsed = JSON.parse(text) as { fixtures: { cases: unknown[] }[] };
  console.log(
    `wrote sandbox/conformance/corpus.json: ${parsed.fixtures.length} fixtures, ${parsed.fixtures.reduce((n, f) => n + f.cases.length, 0)} cases`,
  );
}
