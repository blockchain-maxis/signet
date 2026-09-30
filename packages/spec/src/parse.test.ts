import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseContractSpec, CONTRACT_SPEC_SECTION } from './parse.ts';
import { readCustomSections } from './wasm-sections.ts';
import { STELLAR_SDK_VERSION } from './sdk-version.ts';
import { isSpecReadError } from './errors.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(here, '..', 'fixtures');

const manifest: Record<string, { file: string; wasmHash: string }> = JSON.parse(
  readFileSync(join(FIXTURES_DIR, 'manifest.json'), 'utf8'),
);

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES_DIR, `${name}.wasm`)));
}

/** Run `fn` and return the SpecReadError it throws — asserting on kind, never on message. */
function thrown(fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    assert.ok(isSpecReadError(err), `expected a SpecReadError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected a throw');
}

/** A module header followed by the given raw section bytes. */
function moduleWith(...sections: number[][]): Uint8Array {
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...sections.flat()]);
}

/** A custom section (id 0) named `name` carrying `payload`. Sizes stay < 128, so one-byte LEB128. */
function customSection(name: string, payload: number[]): number[] {
  const nameBytes = [...new TextEncoder().encode(name)];
  const body = [nameBytes.length, ...nameBytes, ...payload];
  return [0, body.length, ...body];
}

// ── the registry fixture ─────────────────────────────────────────────────

test('the identity-registry fixture decodes to 9 entries: 8 functions and 1 error enum', () => {
  const spec = parseContractSpec(fixture('identity-registry'));

  assert.equal(spec.entries.length, 9);
  const kinds = spec.entries.map((e) => e.switch().name);
  assert.equal(kinds.filter((k) => k === 'scSpecEntryFunctionV0').length, 8);
  assert.equal(kinds.filter((k) => k === 'scSpecEntryUdtErrorEnumV0').length, 1);

  assert.equal(spec.wasmHash, manifest['identity-registry']!.wasmHash);
  assert.equal(spec.sdkVersion, STELLAR_SDK_VERSION);
  assert.equal(spec.spec.entries.length, 9, 'spec is the SDK helper over the same entries');
});

test('the flattened views are empty and build is undefined until #430/#431/#432', () => {
  const spec = parseContractSpec(fixture('identity-registry'));
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.types, []);
  assert.deepEqual(spec.errors, []);
  assert.deepEqual(spec.events, []);
  assert.equal(spec.build, undefined);
});

test('wasmHash is the manifest value, lowercase hex, for every fixture that has an interface', () => {
  for (const [key, entry] of Object.entries(manifest)) {
    if (key === 'no_spec' || key === 'corrupt_section') continue;
    const spec = parseContractSpec(fixture(entry.file.replace(/\.wasm$/, '')));
    assert.equal(spec.wasmHash, entry.wasmHash, key);
    assert.match(spec.wasmHash, /^[0-9a-f]{64}$/, key);
  }
});

// ── failures, by kind ────────────────────────────────────────────────────

test('no_spec.wasm has no interface section', () => {
  const err = thrown(() => parseContractSpec(fixture('no_spec')));
  assert.equal(err.kind, 'no_interface');
  assert.equal(err.kind === 'no_interface' && err.reason, 'no_section');
});

test('a zero-length contractspecv0 section is an empty interface, not a missing one', () => {
  const err = thrown(() => parseContractSpec(moduleWith(customSection(CONTRACT_SPEC_SECTION, []))));
  assert.equal(err.kind, 'no_interface');
  assert.equal(err.kind === 'no_interface' && err.reason, 'empty_section');
});

test('corrupt_section.wasm is unreadable, and says which SDK could not read it', () => {
  const err = thrown(() => parseContractSpec(fixture('corrupt_section')));
  assert.equal(err.kind, 'interface_unreadable');
  assert.equal(err.kind === 'interface_unreadable' && err.sdkVersion, STELLAR_SDK_VERSION);
});

test('random bytes are not a WebAssembly module', () => {
  // Seeded, so a failure reproduces. A mulberry32 stream is plenty for "not a module".
  let seed = 0x5eed;
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) & 0xff;
  };
  for (const length of [0, 1, 7, 8, 64, 4096]) {
    const bytes = Uint8Array.from({ length }, next);
    assert.equal(thrown(() => parseContractSpec(bytes)).kind, 'invalid_wasm', `${length} bytes`);
  }
});

test('a valid header with broken framing is still an invalid module', () => {
  const cases: Record<string, Uint8Array> = {
    'wrong version': new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]),
    'section runs past the end': moduleWith([0, 0x10, 0x01, 0x61]),
    'truncated LEB128 size': moduleWith([0, 0x80]),
    'LEB128 wider than u32': moduleWith([0, 0xff, 0xff, 0xff, 0xff, 0x7f]),
    'name runs past its section': moduleWith([0, 0x02, 0x05, 0x61]),
    'name is not UTF-8': moduleWith([0, 0x02, 0x01, 0xff]),
  };
  for (const [label, bytes] of Object.entries(cases)) {
    assert.equal(thrown(() => parseContractSpec(bytes)).kind, 'invalid_wasm', label);
  }
});

// ── the walker against the engine ────────────────────────────────────────

test('the walker returns the same custom sections as WebAssembly.Module.customSections, byte for byte', () => {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.wasm'));
  assert.ok(files.length >= 7, 'every committed fixture is covered');

  for (const file of files) {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES_DIR, file)));
    const walked = readCustomSections(bytes);
    const module = new WebAssembly.Module(bytes);

    const names = new Set([CONTRACT_SPEC_SECTION, ...walked.keys()]);
    for (const name of names) {
      const engine = WebAssembly.Module.customSections(module, name).map((b) => new Uint8Array(b));
      const ours = walked.get(name) ?? [];
      assert.equal(ours.length, engine.length, `${file}: number of "${name}" sections`);
      ours.forEach((section, i) => {
        assert.ok(
          Buffer.from(section).equals(Buffer.from(engine[i]!)),
          `${file}: "${name}"[${i}] bytes`,
        );
      });
    }
  }
});

test('a custom-section name may repeat, and every occurrence is kept in order', () => {
  const sections = readCustomSections(
    moduleWith(customSection('meta', [1]), [1, 0], customSection('meta', [2, 3])),
  );
  assert.deepEqual(
    (sections.get('meta') ?? []).map((s) => [...s]),
    [[1], [2, 3]],
  );
});

// ── keeping it isomorphic and honest ─────────────────────────────────────

test('STELLAR_SDK_VERSION matches the installed @stellar/stellar-sdk', () => {
  const pkg = JSON.parse(
    readFileSync(
      join(here, '..', 'node_modules', '@stellar', 'stellar-sdk', 'package.json'),
      'utf8',
    ),
  );
  assert.equal(STELLAR_SDK_VERSION, pkg.version, 'bump src/sdk-version.ts with the dependency');
});

test('parse.ts and wasm-sections.ts use no fetch, fs or process', () => {
  // These run in the browser. Comments are stripped first: both files explain,
  // in prose, why they avoid exactly these names.
  const forbidden = [
    /\bfrom\s+['"](node:)?(fs|fs\/promises|process|http|https|net|child_process)['"]/,
    /\bimport\s*\(\s*['"](node:)?(fs|fs\/promises|process)['"]/,
    /\brequire\s*\(/,
    /\bfetch\s*\(/,
    /\bprocess\s*\./,
  ];
  for (const file of ['parse.ts', 'wasm-sections.ts']) {
    const code = readFileSync(join(here, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const pattern of forbidden) {
      assert.doesNotMatch(code, pattern, `${file} must stay isomorphic`);
    }
  }
});
