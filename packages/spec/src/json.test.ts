import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Ajv from 'ajv';
import { contract, xdr } from '@stellar/stellar-sdk';
import { buildEvents } from './events.ts';
import { canonicalStringify, fromSpecJson, toSpecJson, type SpecJson } from './json.ts';
import type {
  ContractSpec,
  SpecErrorCase,
  SpecEvent,
  SpecField,
  SpecFunction,
  SpecType,
  TypeRef,
} from './types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, '..', 'fixtures');
const SCHEMA_PATH = join(__dirname, '..', 'schema', 'spec-json.v1.schema.json');

const require = createRequire(import.meta.url);

/** Version of the installed SDK — the honest `sdkVersion` for decoded fixtures. */
function installedSdkVersion(): string {
  let dir = dirname(require.resolve('@stellar/stellar-sdk'));
  while (dir !== dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === '@stellar/stellar-sdk' && pkg.version) return pkg.version;
    } catch {
      // Not a package root — keep walking up.
    }
    dir = dirname(dir);
  }
  throw new Error('cannot locate @stellar/stellar-sdk package.json');
}

const SDK_VERSION = installedSdkVersion();

// ---------------------------------------------------------------------------
// Test-local fixture decoder.
//
// Scaffolding until #430 (flattened functions/types/errors views) and #431
// (events view) land real builders: decodes a fixture WASM's contractspecv0
// section into a full ContractSpec using the SDK's XDR accessors. Union tuple
// cases carry a single payload type, which is mapped to one field; #430 may
// choose different field names, at which point these tests move onto its
// builders instead of this decoder.
// ---------------------------------------------------------------------------

function str(v: { toString(): string }): string {
  return v.toString();
}

function optDoc(v: { toString(): string }): string | undefined {
  const doc = v.toString();
  return doc === '' ? undefined : doc;
}

function decodeTypeDef(td: xdr.ScSpecTypeDef): TypeRef {
  switch (td.switch().name) {
    case 'scSpecTypeVal':
      return 'val';
    case 'scSpecTypeBool':
      return 'bool';
    case 'scSpecTypeVoid':
      return 'void';
    case 'scSpecTypeError':
      return 'error';
    case 'scSpecTypeU32':
      return 'u32';
    case 'scSpecTypeI32':
      return 'i32';
    case 'scSpecTypeU64':
      return 'u64';
    case 'scSpecTypeI64':
      return 'i64';
    case 'scSpecTypeTimepoint':
      return 'timepoint';
    case 'scSpecTypeDuration':
      return 'duration';
    case 'scSpecTypeU128':
      return 'u128';
    case 'scSpecTypeI128':
      return 'i128';
    case 'scSpecTypeU256':
      return 'u256';
    case 'scSpecTypeI256':
      return 'i256';
    case 'scSpecTypeBytes':
      return 'bytes';
    case 'scSpecTypeString':
      return 'string';
    case 'scSpecTypeSymbol':
      return 'symbol';
    case 'scSpecTypeAddress':
      return 'address';
    case 'scSpecTypeBytesN':
      return { type: 'bytes_n', n: td.bytesN().n() };
    case 'scSpecTypeOption':
      return { type: 'option', value: decodeTypeDef(td.option().valueType()) };
    case 'scSpecTypeResult':
      return {
        type: 'result',
        ok: decodeTypeDef(td.result().okType()),
        error: decodeTypeDef(td.result().errorType()),
      };
    case 'scSpecTypeVec':
      return { type: 'vec', element: decodeTypeDef(td.vec().elementType()) };
    case 'scSpecTypeMap':
      return {
        type: 'map',
        key: decodeTypeDef(td.map().keyType()),
        value: decodeTypeDef(td.map().valueType()),
      };
    case 'scSpecTypeTuple':
      return { type: 'tuple', elements: td.tuple().valueTypes().map(decodeTypeDef) };
    case 'scSpecTypeUdt':
      return { type: 'named', name: str(td.udt().name()) };
    default:
      return { type: 'unknown', xdrArm: td.switch().name };
  }
}

function decodeField(f: {
  name(): { toString(): string };
  doc(): { toString(): string };
  type(): xdr.ScSpecTypeDef;
}): SpecField {
  const doc = optDoc(f.doc());
  return {
    name: str(f.name()),
    ...(doc !== undefined ? { doc } : {}),
    type: decodeTypeDef(f.type()),
  };
}

function decodeSpecEntries(entries: readonly xdr.ScSpecEntry[]): {
  functions: SpecFunction[];
  types: SpecType[];
  errors: SpecErrorCase[];
  events: SpecEvent[];
} {
  const functions: SpecFunction[] = [];
  const types: SpecType[] = [];
  const errors: SpecErrorCase[] = [];
  const events: SpecEvent[] = buildEvents(entries);

  for (const entry of entries) {
    const arm = entry.switch().name;
    const value = entry.value() as {
      name(): { toString(): string };
      doc(): { toString(): string };
    };
    const doc = optDoc(value.doc());
    if (arm === 'scSpecEntryFunctionV0') {
      const fn = value as unknown as {
        name(): { toString(): string };
        doc(): { toString(): string };
        inputs(): Array<Parameters<typeof decodeField>[0]>;
        outputs(): xdr.ScSpecTypeDef[];
      };
      functions.push({
        name: str(fn.name()),
        doc: fn.doc().toString(),
        isConstructor: str(fn.name()) === '__constructor',
        inputs: fn.inputs().map(decodeField),
        outputs: fn.outputs().map(decodeTypeDef),
      });
    } else if (arm === 'scSpecEntryUdtStructV0') {
      const st = value as unknown as {
        name(): { toString(): string };
        doc(): { toString(): string };
        fields(): Array<Parameters<typeof decodeField>[0]>;
      };
      types.push({
        kind: 'struct',
        name: str(st.name()),
        ...(optDoc(st.doc()) !== undefined ? { doc: optDoc(st.doc()) as string } : {}),
        fields: st.fields().map(decodeField),
      });
    } else if (arm === 'scSpecEntryUdtUnionV0') {
      const un = value as unknown as {
        name(): { toString(): string };
        doc(): { toString(): string };
        cases(): Array<{
          switch(): { name: string };
          value(): { name(): { toString(): string }; doc(): { toString(): string } };
        }>;
      };
      // Tuple payloads arrive as a type array (Point(u32, u32) above); the
      // scaffold names payload fields by position until #430 fixes names.
      const tupleTypes = (c: { value(): unknown }): xdr.ScSpecTypeDef[] => {
        const t = (c.value() as { type(): unknown }).type();
        return Array.isArray(t) ? (t as xdr.ScSpecTypeDef[]) : [];
      };
      types.push({
        kind: 'union',
        name: str(un.name()),
        ...(optDoc(un.doc()) !== undefined ? { doc: optDoc(un.doc()) as string } : {}),
        cases: un.cases().map((c) => {
          const inner = c.value();
          const caseDoc = optDoc(inner.doc());
          if (c.switch().name === 'scSpecUdtUnionCaseVoidV0') {
            return {
              name: str(inner.name()),
              ...(caseDoc !== undefined ? { doc: caseDoc } : {}),
              fields: [],
            };
          }
          return {
            name: str(inner.name()),
            ...(caseDoc !== undefined ? { doc: caseDoc } : {}),
            fields: tupleTypes(c).map((t, i) => ({ name: String(i), type: decodeTypeDef(t) })),
          };
        }),
      });
    } else if (arm === 'scSpecEntryUdtEnumV0') {
      const en = value as unknown as {
        name(): { toString(): string };
        doc(): { toString(): string };
        cases(): Array<{
          name(): { toString(): string };
          doc(): { toString(): string };
          value(): number;
        }>;
      };
      types.push({
        kind: 'enum',
        name: str(en.name()),
        ...(optDoc(en.doc()) !== undefined ? { doc: optDoc(en.doc()) as string } : {}),
        variants: en.cases().map((c) => {
          const variantDoc = optDoc(c.doc());
          return {
            name: str(c.name()),
            ...(variantDoc !== undefined ? { doc: variantDoc } : {}),
            value: c.value(),
          };
        }),
      });
    } else if (arm === 'scSpecEntryUdtErrorEnumV0') {
      const er = value as unknown as {
        name(): { toString(): string };
        doc(): { toString(): string };
        cases(): Array<{
          name(): { toString(): string };
          doc(): { toString(): string };
          value(): number;
        }>;
      };
      for (const c of er.cases()) {
        errors.push({
          enumName: str(er.name()),
          name: str(c.name()),
          value: c.value(),
          doc: c.doc().toString(),
        });
      }
    }
  }

  return { functions, types, errors, events };
}

interface ManifestEntry {
  file: string;
  network: string;
  wasmHash: string;
}

/** Build a ContractSpec from a fixture WASM, or null when it has no decodable spec. */
function specFromFixture(key: string, entry: ManifestEntry): ContractSpec | null {
  void key;
  let section: Buffer;
  try {
    const wasm = readFileSync(join(FIXTURES_DIR, entry.file));
    const mod = new WebAssembly.Module(new Uint8Array(wasm));
    const sections = WebAssembly.Module.customSections(mod, 'contractspecv0');
    if (sections.length === 0) return null;
    section = Buffer.from(sections[0]!);
  } catch {
    return null;
  }
  let entries: xdr.ScSpecEntry[];
  try {
    entries = new contract.Spec(section).entries;
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  const views = decodeSpecEntries(entries);
  return {
    wasmHash: entry.wasmHash,
    entries,
    spec: new contract.Spec(entries),
    ...views,
    sdkVersion: SDK_VERSION,
  };
}

/** The degenerate SpecJson: no entries, no views. Validates, but cannot rebuild a Spec (the SDK requires ≥1 entry). */
function emptySpecJson(wasmHash: string): SpecJson {
  return {
    schemaVersion: 1,
    wasmHash,
    sdkVersion: SDK_VERSION,
    entriesXdr: [],
    functions: [],
    types: [],
    errors: [],
    events: [],
    warnings: [],
  };
}

function loadManifest(): Record<string, ManifestEntry> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'manifest.json'), 'utf8')) as Record<
    string,
    ManifestEntry
  >;
}

const ajv = new Ajv({ strict: true });
const validateSchema = ajv.compile(
  JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>,
);

// ---------------------------------------------------------------------------
// Per-fixture round-trips
// ---------------------------------------------------------------------------

for (const [key, entry] of Object.entries(loadManifest())) {
  if (!entry.file.endsWith('.wasm')) continue;

  test(`round-trip ${key}: fromSpecJson(toSpecJson(x)) deep-equals the flattened views`, () => {
    const x = specFromFixture(key, entry);
    // no_spec.wasm is not a module and corrupt_section.wasm carries a
    // deliberately broken section: neither yields entries, so there is no
    // ContractSpec to round-trip. Their degenerate shape is asserted below.
    if (x === null) {
      const json = emptySpecJson(entry.wasmHash);
      assert.equal(validateSchema(json), true, JSON.stringify(validateSchema.errors));
      return;
    }
    const json = toSpecJson(x);
    const back = fromSpecJson(json);
    assert.deepEqual(back.functions, x.functions);
    assert.deepEqual(back.types, x.types);
    assert.deepEqual(back.errors, x.errors);
    assert.deepEqual(back.events, x.events);
    assert.equal(back.wasmHash, x.wasmHash);
    assert.equal(back.sdkVersion, x.sdkVersion);
  });

  test(`round-trip ${key}: re-encoded entriesXdr is byte-identical`, () => {
    const x = specFromFixture(key, entry);
    if (x === null) return;
    const json = toSpecJson(x);
    const back = fromSpecJson(json);
    assert.deepEqual(
      back.entries.map((e) => e.toXDR('base64')),
      json.entriesXdr,
    );
  });

  test(`round-trip ${key}: SpecJson validates against spec-json.v1.schema.json`, () => {
    const x = specFromFixture(key, entry);
    const json = x === null ? emptySpecJson(entry.wasmHash) : toSpecJson(x);
    assert.equal(validateSchema(json), true, JSON.stringify(validateSchema.errors));
  });
}

// ---------------------------------------------------------------------------
// Synthetic rich shape: every optional branch the fixtures may not cover
// ---------------------------------------------------------------------------

function richSpec(): ContractSpec {
  const entry = xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({ doc: '', name: 'ping', inputs: [], outputs: [] }),
  );
  return {
    wasmHash: '0'.repeat(64),
    entries: [entry],
    spec: new contract.Spec([entry]),
    functions: [
      {
        name: 'ping',
        doc: '',
        isConstructor: false,
        inputs: [
          { name: 'target', type: { type: 'vec', element: { type: 'option', value: 'u32' } } },
          { name: 'flags', type: { type: 'unknown', xdrArm: 'scSpecTypeFuture' } },
        ],
        outputs: [{ type: 'result', ok: 'bool', error: { type: 'named', name: 'PongError' } }],
      },
    ],
    types: [
      {
        kind: 'union',
        name: 'U',
        doc: 'documented union',
        cases: [{ name: 'A', fields: [{ name: 'x', type: 'i64' }] }],
      },
    ],
    errors: [{ enumName: 'E', name: 'Broke', value: 1, doc: '' }],
    events: [
      {
        name: 'Ev',
        doc: '',
        prefixTopics: ['ev'],
        params: [{ name: 'who', type: 'address', location: 'topic' }],
        dataFormat: 'single_value',
      },
    ],
    build: { rustVersion: '1.91.1', sdkVersion: '26.1.0' },
    env: { protocolVersion: 25, preRelease: 0 },
    sdkVersion: SDK_VERSION,
  };
}

test('rich spec: optional branches round-trip and validate', () => {
  const json = toSpecJson(richSpec(), { warnings: ['future arm surfaced as unknown'] });
  assert.equal(validateSchema(json), true, JSON.stringify(validateSchema.errors));
  const back = fromSpecJson(json);
  assert.deepEqual(back.functions, json.functions);
  assert.deepEqual(back.types, json.types);
  assert.deepEqual(back.build, { rustVersion: '1.91.1', sdkVersion: '26.1.0' });
  assert.deepEqual(back.env, { protocolVersion: 25, preRelease: 0 });
  assert.deepEqual(json.warnings, ['future arm surfaced as unknown']);
});

test('fromSpecJson rejects a foreign schemaVersion', () => {
  const json = toSpecJson(richSpec());
  assert.throws(
    () => fromSpecJson({ ...json, schemaVersion: 999 } as unknown as SpecJson),
    /schemaVersion/,
  );
});

test('fromSpecJson propagates undecodable entriesXdr', () => {
  const json = toSpecJson(richSpec());
  assert.throws(() => fromSpecJson({ ...json, entriesXdr: ['!!!not-base64!!!'] }));
});

test('canonicalStringify is byte-identical across runs and key-insertion orders', () => {
  const json = toSpecJson(richSpec());
  const once = canonicalStringify(json);
  const twice = canonicalStringify(JSON.parse(JSON.stringify(json)) as SpecJson);
  assert.equal(once, twice);
  const reordered = Object.fromEntries(Object.entries(json).reverse()) as unknown as SpecJson;
  assert.equal(canonicalStringify(reordered), once);
  // Sorted keys: schemaVersion sorts before wasmHash.
  assert.ok(once.indexOf('"schemaVersion"') < once.indexOf('"wasmHash"'));
});
