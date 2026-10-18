import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parseContractSpec } from './parse.ts';
import { toSpecJson } from './json.ts';
import {
  toOrbitalSpec,
  toOrbitalTypeSpec,
  NotRepresentable,
  PRIMITIVE_MAPPINGS,
  type OrbitalTypeSpec,
  type OrbitalContractSpec,
} from './orbital.ts';
import type { TypeRef } from './types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, '..', 'fixtures');
const VENDOR_SCHEMA_PATH = join(
  __dirname,
  '..',
  'schema',
  'vendor',
  'orbital-spec.schema.json',
);

interface ManifestEntry {
  file: string;
  sourceContract: string;
  network: string;
  wasmHash: string;
  bytes: number;
}

function loadManifest(): Record<string, ManifestEntry> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'manifest.json'), 'utf8')) as Record<
    string,
    ManifestEntry
  >;
}

test('vendored Orbital spec schema exists and compiles under Ajv2020', () => {
  assert.ok(existsSync(VENDOR_SCHEMA_PATH), 'orbital-spec.schema.json must exist');
  const schema = JSON.parse(readFileSync(VENDOR_SCHEMA_PATH, 'utf8')) as Record<
    string,
    unknown
  >;
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(schema);
  assert.equal(typeof validate, 'function');
});

test('primitive mappings map all Signet primitives, including extensions', () => {
  assert.equal(PRIMITIVE_MAPPINGS.timepoint, 'u64');
  assert.equal(PRIMITIVE_MAPPINGS.duration, 'u64');
  assert.equal(PRIMITIVE_MAPPINGS.muxedAddress, 'address');
  assert.equal(PRIMITIVE_MAPPINGS.val, 'u64');

  assert.equal(toOrbitalTypeSpec('timepoint'), 'u64');
  assert.equal(toOrbitalTypeSpec('duration'), 'u64');
  assert.equal(toOrbitalTypeSpec('muxedAddress'), 'address');
  assert.equal(toOrbitalTypeSpec('val'), 'u64');
});

test('unknown TypeRef throws typed NotRepresentable error', () => {
  const unknownType: TypeRef = { type: 'unknown', xdrArm: 'scSpecTypeFutureArm' };
  assert.throws(
    () => toOrbitalTypeSpec(unknownType),
    (err: unknown) => {
      assert.ok(err instanceof NotRepresentable);
      assert.equal((err as Error).name, 'NotRepresentable');
      assert.match((err as Error).message, /scSpecTypeFutureArm/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Acceptance Criteria 1 & 2:
// - Every fixture's export validates against the vendored Orbital schema.
// - `xdrEntries` in the export equals `SpecJson.entriesXdr`.
// ---------------------------------------------------------------------------

const schemaJson = JSON.parse(readFileSync(VENDOR_SCHEMA_PATH, 'utf8')) as Record<
  string,
  unknown
>;
const ajv = new Ajv2020({ strict: false });
const validateOrbitalSchema = ajv.compile(schemaJson);

const VALID_FIXTURE_KEYS = [
  'identity-registry',
  'types_zoo',
  'undocumented',
  'events',
  'errors_multi',
];

for (const key of VALID_FIXTURE_KEYS) {
  test(`fixture "${key}": export validates against Orbital schema and matches SpecJson.entriesXdr`, () => {
    const manifest = loadManifest();
    const entry = manifest[key];
    assert.ok(entry, `fixture ${key} must exist in manifest`);

    const wasmPath = join(FIXTURES_DIR, entry.file);
    const wasmBytes = readFileSync(wasmPath);
    const spec = parseContractSpec(wasmBytes);
    const specJson = toSpecJson(spec);

    const options = {
      name: key.replace(/[^a-zA-Z0-9_]/g, '_'),
      version: '1.0.0',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      network: 'testnet' as const,
      description: `Exported fixture ${key}`,
    };

    // 1. Export from ContractSpec
    const fromSpec = toOrbitalSpec(spec, options);
    const valid1 = validateOrbitalSchema(fromSpec);
    assert.ok(
      valid1,
      `from ContractSpec schema validation failed: ${JSON.stringify(validateOrbitalSchema.errors)}`,
    );

    // 2. Export from SpecJson
    const fromJson = toOrbitalSpec(specJson, options);
    const valid2 = validateOrbitalSchema(fromJson);
    assert.ok(
      valid2,
      `from SpecJson schema validation failed: ${JSON.stringify(validateOrbitalSchema.errors)}`,
    );

    // 3. xdrEntries equals SpecJson.entriesXdr
    assert.deepEqual(fromSpec.xdrEntries, specJson.entriesXdr);
    assert.deepEqual(fromJson.xdrEntries, specJson.entriesXdr);
  });
}

// ---------------------------------------------------------------------------
// Acceptance Criterion:
// - `types_zoo` covers every Orbital `TypeSpec` tag.
// ---------------------------------------------------------------------------

test('types_zoo covers every Orbital TypeSpec composite tag and core primitive set', () => {
  const manifest = loadManifest();
  const entry = manifest['types_zoo'];
  assert.ok(entry, 'types_zoo must exist in manifest');
  const wasmPath = join(FIXTURES_DIR, entry.file);
  const spec = parseContractSpec(readFileSync(wasmPath));

  const orbitalSpec: OrbitalContractSpec = toOrbitalSpec(spec, {
    name: 'types_zoo',
    version: '1.0.0',
  });

  const observedTags = new Set<string>();

  function collectTags(type: OrbitalTypeSpec) {
    if (typeof type === 'string') {
      observedTags.add(type);
      return;
    }
    observedTags.add(type.type);
    switch (type.type) {
      case 'bytes_n':
        break;
      case 'option':
        collectTags(type.inner);
        break;
      case 'result':
        collectTags(type.ok);
        collectTags(type.err);
        break;
      case 'vec':
        collectTags(type.item);
        break;
      case 'map':
        collectTags(type.key);
        collectTags(type.value);
        break;
      case 'tuple':
        for (const el of type.elements) collectTags(el);
        break;
      case 'named':
        break;
    }
  }

  // Walk functions
  for (const fn of orbitalSpec.functions) {
    collectTags(fn.returns);
    for (const p of fn.params) {
      collectTags(p.type);
    }
  }

  // Walk types
  for (const udt of Object.values(orbitalSpec.types)) {
    if (udt.kind === 'struct') {
      for (const f of udt.fields) collectTags(f.type);
    } else if (udt.kind === 'union') {
      for (const c of udt.cases) {
        for (const f of c.fields) collectTags(f.type);
      }
    } else if (udt.kind === 'enum') {
      for (const v of udt.variants) {
        if (v.value) collectTags(v.value);
      }
    }
  }

  // Every composite Orbital TypeSpec tag must appear in types_zoo:
  const requiredCompositeTags = [
    'bytes_n',
    'option',
    'result',
    'vec',
    'map',
    'tuple',
    'named',
  ];

  for (const tag of requiredCompositeTags) {
    assert.ok(
      observedTags.has(tag),
      `types_zoo must cover Orbital TypeSpec composite tag '${tag}'`,
    );
  }

  // Primitives present in types_zoo
  const expectedPrimitives = [
    'bool',
    'u32',
    'i32',
    'u64',
    'i64',
    'u128',
    'i128',
    'u256',
    'i256',
    'bytes',
    'string',
    'symbol',
    'address',
    'void',
  ];
  for (const prim of expectedPrimitives) {
    assert.ok(
      observedTags.has(prim),
      `types_zoo must cover primitive '${prim}'`,
    );
  }
});
