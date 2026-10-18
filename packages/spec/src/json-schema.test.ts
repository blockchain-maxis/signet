import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { parseContractSpec } from './parse.ts';
import { toSpecJson } from './json.ts';
import {
  allFunctionSchemas,
  functionArgsSchema,
  type JSONSchema7,
} from './json-schema.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, '..', 'fixtures');
const SCHEMA_PATH = join(__dirname, '..', 'schema', 'spec-json.v1.schema.json');

const ajv = new Ajv({ strict: false });

function fixtureSpec(name: string) {
  return parseContractSpec(readFileSync(join(FIXTURES_DIR, `${name}.wasm`)));
}

test('every function in every fixture compiles cleanly under Ajv (strict: false)', () => {
  const wasmFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.wasm'));
  assert.ok(wasmFiles.length >= 4, 'fixtures directory contains test WASM files');

  let totalFunctions = 0;
  for (const file of wasmFiles) {
    let spec;
    try {
      spec = parseContractSpec(readFileSync(join(FIXTURES_DIR, file)));
    } catch {
      // no_spec.wasm, corrupt_section.wasm, etc. are expected not to have an interface
      continue;
    }
    const schemas = allFunctionSchemas(spec);
    for (const [fnName, schema] of Object.entries(schemas)) {
      totalFunctions++;
      assert.doesNotThrow(() => {
        ajv.compile(schema);
      }, `Schema for ${file}::${fnName} failed to compile under Ajv`);
    }
  }
  assert.ok(totalFunctions > 0, 'at least one function schema compiled');
});

test('identity-registry claim: valid args validate, missing wallet fails', () => {
  const spec = fixtureSpec('identity-registry');
  const schema = functionArgsSchema(spec, 'claim');

  const validate = ajv.compile(schema);

  // Valid argument set
  const valid = {
    handle: 'alice',
    wallet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  };
  assert.equal(validate(valid), true, `Expected valid args: ${JSON.stringify(validate.errors)}`);

  // Missing wallet
  const missingWallet = {
    handle: 'alice',
  };
  assert.equal(validate(missingWallet), false, 'Expected missing wallet to fail validation');

  // Missing handle
  const missingHandle = {
    wallet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  };
  assert.equal(validate(missingHandle), false, 'Expected missing handle to fail validation');

  // Extra unknown property (additionalProperties: false)
  const extraProp = {
    handle: 'alice',
    wallet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    unknownField: 123,
  };
  assert.equal(validate(extraProp), false, 'Expected extra property to fail validation');
});

test('types_zoo nested: accepts valid nested struct value and rejects wrong-typed leaf', () => {
  const spec = fixtureSpec('types_zoo');
  const schema = functionArgsSchema(spec, 'nested');

  const validate = ajv.compile(schema);

  // Valid 3-level struct
  const valid = {
    v: {
      inner: {
        inner: {
          value: 42,
        },
      },
    },
  };
  assert.equal(validate(valid), true, `Expected nested struct to validate: ${JSON.stringify(validate.errors)}`);

  // Wrong-typed leaf (string instead of U32 integer)
  const wrongLeaf = {
    v: {
      inner: {
        inner: {
          value: 'forty-two',
        },
      },
    },
  };
  assert.equal(validate(wrongLeaf), false, 'Expected wrong-typed leaf to fail validation');

  // Missing inner field
  const missingInner = {
    v: {
      inner: {},
    },
  };
  assert.equal(validate(missingInner), false, 'Expected missing inner field to fail validation');
});

test('definitions pruning: definitions only include types reachable by the function', () => {
  const spec = fixtureSpec('types_zoo');
  const schema = functionArgsSchema(spec, 'nested');

  assert.ok(schema.definitions, 'definitions should be present');
  const defKeys = Object.keys(schema.definitions).sort();
  // Level1 -> Level2 -> Level3 -> U32
  assert.deepEqual(defKeys, ['Level1', 'Level2', 'Level3', 'U32']);

  // Assert unrelated types from types_zoo (e.g. Color, Shape, Address, DataUrl) are NOT in definitions
  assert.equal('Color' in schema.definitions, false);
  assert.equal('Shape' in schema.definitions, false);
  assert.equal('Address' in schema.definitions, false);
  assert.equal('DataUrl' in schema.definitions, false);
  // Function names themselves must not be in definitions
  assert.equal('nested' in schema.definitions, false);
  assert.equal('claim' in schema.definitions, false);
});

test('pinned SDK conventions: i128, u128, u256 are strings; Address has format; BytesN has DataUrl pattern; Option is omitted from required', () => {
  const spec = fixtureSpec('types_zoo');

  // ints function tests integer types
  const intsSchema = functionArgsSchema(spec, 'ints');
  const defs = intsSchema.definitions as Record<string, Record<string, unknown>>;

  // u128, i128, u256, i256 conventions
  assert.equal(defs['U128']?.type, 'string');
  assert.equal(defs['U128']?.pattern, '^([1-9][0-9]*|0)$');

  assert.equal(defs['I128']?.type, 'string');
  assert.equal(defs['I128']?.pattern, '^(-?[1-9][0-9]*|0)$');

  assert.equal(defs['U256']?.type, 'string');
  assert.equal(defs['U256']?.pattern, '^([1-9][0-9]*|0)$');

  assert.equal(defs['I256']?.type, 'string');
  assert.equal(defs['I256']?.pattern, '^(-?[1-9][0-9]*|0)$');

  // Address convention
  const whoSchema = functionArgsSchema(spec, 'who');
  const whoDefs = whoSchema.definitions as Record<string, Record<string, unknown>>;
  assert.equal(whoDefs['Address']?.type, 'string');
  assert.equal(whoDefs['Address']?.format, 'address');

  // BytesN convention in blobs
  const blobsSchema = functionArgsSchema(spec, 'blobs');
  const blobsProps = blobsSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(blobsProps['fixed']?.$ref, '#/definitions/DataUrl');
  assert.equal(blobsProps['fixed']?.maxLength, 32);

  // Option convention in maybe (v is optional, so required does not include v)
  const maybeSchema = functionArgsSchema(spec, 'maybe');
  assert.ok(!maybeSchema.required || !maybeSchema.required.includes('v'));
});

test('toSpecJson with includeFunctionSchemas validates against spec-json.v1.schema.json', () => {
  const spec = fixtureSpec('identity-registry');
  const json = toSpecJson(spec, { includeFunctionSchemas: true });

  assert.ok(json.functionSchemas, 'functionSchemas should be populated');
  assert.ok(json.functionSchemas['claim'], 'claim schema should exist');

  const metaSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const validateSpecJson = ajv.compile(metaSchema);
  assert.equal(
    validateSpecJson(json),
    true,
    `SpecJson failed schema validation: ${JSON.stringify(validateSpecJson.errors)}`,
  );
});
