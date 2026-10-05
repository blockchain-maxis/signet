import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { xdr } from '@stellar/stellar-sdk';

import { parseContractSpec } from './parse.ts';
import { decodeBuildMeta, decodeEnvMeta, readContractMeta } from './meta.ts';
import { readCustomSections } from './wasm-sections.ts';
import { fromSpecJson, toSpecJson } from './json.ts';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES_DIR, `${name}.wasm`)));
}

function moduleWith(...sections: number[][]): Uint8Array {
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...sections.flat()]);
}

/** Unsigned LEB128, since a real spec section is well over 127 bytes. */
function leb128(value: number): number[] {
  const bytes: number[] = [];
  do {
    const low = value & 0x7f;
    value >>>= 7;
    bytes.push(value === 0 ? low : low | 0x80);
  } while (value !== 0);
  return bytes;
}

/** A custom section (id 0) named `name` carrying `payload`. */
function customSection(name: string, payload: Uint8Array): number[] {
  const nameBytes = [...new TextEncoder().encode(name)];
  const body = [...leb128(nameBytes.length), ...nameBytes, ...payload];
  return [0, ...leb128(body.length), ...body];
}

function metaEntry(key: string, val: string): Uint8Array {
  return xdr.ScMetaEntry.scMetaV0(
    new xdr.ScMetaV0({ key: Buffer.from(key), val: Buffer.from(val) }),
  ).toXDR();
}

function envEntry(protocol: number, preRelease: number): Uint8Array {
  return xdr.ScEnvMetaEntry.scEnvMetaKindInterfaceVersion(
    new xdr.ScEnvMetaEntryInterfaceVersion({ protocol, preRelease }),
  ).toXDR();
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}

/** The spec of a real fixture, so a synthetic module still parses. */
function specSectionOf(name: string): Uint8Array {
  return readCustomSections(fixture(name)).get('contractspecv0')![0]!;
}

// ── the registry fixture ─────────────────────────────────────────────────

test('the identity-registry fixture records the Rust and SDK versions', () => {
  const { build } = parseContractSpec(fixture('identity-registry'));

  assert.ok(build);
  assert.equal(build.rustVersion, '1.91.1');
  assert.ok(build.sdkVersion?.startsWith('26.1.0'), `sdkVersion was ${build.sdkVersion}`);
  assert.equal(build.entries['rsver'], '1.91.1');
  assert.equal(build.entries['rssdkver'], build.sdkVersion);
});

test('the identity-registry fixture records the protocol interface version', () => {
  const { env } = parseContractSpec(fixture('identity-registry'));

  assert.ok(env);
  assert.equal(env.protocolVersion, 26);
  assert.equal(env.preRelease, 0);
});

test('a clean parse has no warnings', () => {
  assert.deepEqual(parseContractSpec(fixture('identity-registry')).warnings, []);
});

test('keys the reader does not know are kept in entries and never lifted', () => {
  const { build } = parseContractSpec(fixture('types_zoo'));

  assert.ok(build);
  assert.equal(build.entries['rssdk_spec_shaking'], '2');
  assert.equal('rssdk_spec_shaking' in build, false);
  assert.equal(build.rustVersion, '1.97.1');
});

// ── independence from the spec ───────────────────────────────────────────

test('no_spec.wasm has no meta: build and env are undefined, with no throw and no warning', () => {
  const meta = readContractMeta(readCustomSections(fixture('no_spec')));

  assert.equal(meta.build, undefined);
  assert.equal(meta.env, undefined);
  assert.deepEqual(meta.warnings, []);
});

test('meta is read independently of the spec: a module with meta but no spec still decodes it', () => {
  const meta = readContractMeta(
    readCustomSections(moduleWith(customSection('contractmetav0', metaEntry('rsver', '1.91.1')))),
  );

  assert.equal(meta.build?.rustVersion, '1.91.1');
  assert.throws(
    () => parseContractSpec(moduleWith(customSection('contractmetav0', metaEntry('rsver', '1')))),
    (err: unknown) => (err as { kind?: string }).kind === 'no_interface',
  );
});

test('a module with a spec but no meta sections parses with build and env undefined', () => {
  const spec = parseContractSpec(
    moduleWith(customSection('contractspecv0', specSectionOf('events'))),
  );

  assert.equal(spec.build, undefined);
  assert.equal(spec.env, undefined);
  assert.deepEqual(spec.warnings, []);
});

// ── decode failures never fail the parse ─────────────────────────────────

test('a truncated contractmetav0 leaves build undefined and records a warning', () => {
  const valid = metaEntry('rsver', '1.91.1');
  const spec = parseContractSpec(
    moduleWith(
      customSection('contractspecv0', specSectionOf('events')),
      customSection('contractmetav0', valid.subarray(0, valid.length - 3)),
      customSection('contractenvmetav0', envEntry(26, 0)),
    ),
  );

  assert.equal(spec.build, undefined);
  assert.equal(spec.warnings.length, 1);
  assert.match(spec.warnings[0]!, /contractmetav0/);
  assert.deepEqual(spec.env, { protocolVersion: 26, preRelease: 0 }, 'env is independent of build');
  assert.ok(spec.entries.length > 0, 'the interface still decodes');
});

test('a corrupt contractenvmetav0 leaves env undefined and records a warning', () => {
  const spec = parseContractSpec(
    moduleWith(
      customSection('contractspecv0', specSectionOf('events')),
      customSection('contractmetav0', metaEntry('rsver', '1.91.1')),
      customSection('contractenvmetav0', new Uint8Array([0xff, 0xff, 0xff, 0xff])),
    ),
  );

  assert.equal(spec.env, undefined);
  assert.equal(spec.warnings.length, 1);
  assert.match(spec.warnings[0]!, /contractenvmetav0/);
  assert.equal(spec.build?.rustVersion, '1.91.1', 'build is independent of env');
});

test('a value that is not UTF-8 is a decode failure, not a garbled string', () => {
  const entry = xdr.ScMetaEntry.scMetaV0(
    new xdr.ScMetaV0({ key: Buffer.from('rsver'), val: Buffer.from([0xff, 0xfe]) }),
  ).toXDR();
  const result = decodeBuildMeta(entry);

  assert.ok('warning' in result);
});

test('an empty contractenvmetav0 is a warning, and an empty contractmetav0 is an empty build', () => {
  const env = decodeEnvMeta(new Uint8Array());
  assert.ok('warning' in env);

  const build = decodeBuildMeta(new Uint8Array());
  assert.ok('value' in build);
  assert.deepEqual(build.value, { entries: {} });
});

// ── entries ──────────────────────────────────────────────────────────────

test('entries keeps every pair, the last of a repeated key wins, and __proto__ stays data', () => {
  const result = decodeBuildMeta(
    concat(
      metaEntry('rsver', '1.0.0'),
      metaEntry('custom', 'x'),
      metaEntry('rsver', '1.91.1'),
      metaEntry('__proto__', 'polluted'),
    ),
  );

  assert.ok('value' in result);
  assert.equal(result.value.rustVersion, '1.91.1');
  assert.equal(result.value.sdkVersion, undefined);
  assert.equal(Object.getPrototypeOf(result.value.entries), Object.prototype);
  assert.deepEqual(Object.keys(result.value.entries), ['rsver', 'custom', '__proto__']);
  assert.equal(
    Object.getOwnPropertyDescriptor(result.value.entries, '__proto__')?.value,
    'polluted',
  );
});

// ── the JSON form ────────────────────────────────────────────────────────

test('build, env and warnings survive the SpecJson round trip', () => {
  const spec = parseContractSpec(fixture('identity-registry'));
  const json = toSpecJson(spec, { warnings: ['extra'] });

  assert.deepEqual(json.build, spec.build);
  assert.deepEqual(json.env, spec.env);
  assert.deepEqual(json.warnings, ['extra']);

  const back = fromSpecJson(json);
  assert.deepEqual(back.build, spec.build);
  assert.deepEqual(back.env, spec.env);
  assert.deepEqual(back.warnings, ['extra']);
});

test("a parse warning is carried into the spec's JSON", () => {
  const spec = parseContractSpec(
    moduleWith(
      customSection('contractspecv0', specSectionOf('events')),
      customSection('contractmetav0', new Uint8Array([0, 0, 0])),
    ),
  );

  assert.equal(toSpecJson(spec).warnings.length, 1);
  assert.equal(toSpecJson(spec).build, undefined);
});
