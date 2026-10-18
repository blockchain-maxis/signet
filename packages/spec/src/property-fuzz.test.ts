import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { xdr } from '@stellar/stellar-sdk';

import {
  CONTRACT_SPEC_SECTION,
  MAX_SPEC_ENTRIES,
  MAX_WASM_BYTES,
  parseContractSpec,
} from './parse.ts';
import { MAX_WASM_SECTIONS, readCustomSections } from './wasm-sections.ts';
import { MAX_TYPE_DEPTH, toTypeRef } from './type-ref.ts';
import { buildSpecViews } from './views.ts';
import { canonicalStringify, fromSpecJson, toSpecJson, type SpecJson } from './json.ts';
import { decodeBuildMeta, MAX_META_ENTRIES } from './meta.ts';
import {
  InterfaceUnreadable,
  InvalidWasm,
  isSpecReadError,
  type ConcreteSpecReadError,
} from './errors.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', 'fixtures');
const ADVERSARIAL_DIR = join(FIXTURES_DIR, 'adversarial');

/** Fixed seed for reproducible CI runs; configurable run count via `FC_RUNS` (default 200). */
const FC_SEED = 0x516e_6574;
const FC_RUNS = Number(process.env.FC_RUNS ?? 200);

/** Maximum wall-clock time per fuzz / adversarial case (ms). */
const CASE_BUDGET_MS = 200;

/** Maximum heapUsed growth permitted when rejecting an adversarial fixture (16 MB). */
const HEAP_CEILING_BYTES = 16 * 1024 * 1024;

const WASM_HEADER = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function writeLebU32(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return new Uint8Array(bytes);
}

function wrapInCustomSection(name: string, payload: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const nameLen = writeLebU32(nameBytes.byteLength);
  const sectionLen = writeLebU32(nameLen.byteLength + nameBytes.byteLength + payload.byteLength);
  const out = new Uint8Array(
    WASM_HEADER.byteLength +
      1 +
      sectionLen.byteLength +
      nameLen.byteLength +
      nameBytes.byteLength +
      payload.byteLength,
  );
  let offset = 0;
  out.set(WASM_HEADER, offset);
  offset += WASM_HEADER.byteLength;
  out[offset++] = 0x00;
  out.set(sectionLen, offset);
  offset += sectionLen.byteLength;
  out.set(nameLen, offset);
  offset += nameLen.byteLength;
  out.set(nameBytes, offset);
  offset += nameBytes.byteLength;
  out.set(payload, offset);
  return out;
}

function encodeEntriesToWasm(entries: readonly xdr.ScSpecEntry[]): Uint8Array {
  const buffers = entries.map((e) => e.toXDR());
  const payload = Buffer.concat(buffers);
  return wrapInCustomSection(CONTRACT_SPEC_SECTION, new Uint8Array(payload));
}

// ── fast-check arbitraries for xdr.ScSpecEntry ────────────────────────────

const identChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_';

function arbIdentifier(maxLen: number): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...identChars.split('')), { minLength: 1, maxLength: maxLen })
    .map((chars) => chars.join(''));
}

/** Soroban XDR maximum byte length for `doc` strings (`SC_SPEC_DOC_LIMIT`). */
const SC_SPEC_DOC_LIMIT = 1024;

/**
 * Truncate a UTF-8 string cleanly at a code-point boundary so its UTF-8 byte
 * length never exceeds `maxBytes` (XDR's `SC_SPEC_DOC_LIMIT` is 1,024 bytes).
 */
function clampUtf8(input: string, maxBytes: number): string {
  const buf = Buffer.from(input, 'utf8');
  if (buf.byteLength <= maxBytes) return buf.toString('utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Doc string generator covering empty strings, ASCII prose, non-ASCII Unicode
 * (CJK, emoji, combining accents, RTL scripts), and very long strings up to
 * the 1,024-byte `SC_SPEC_DOC_LIMIT`.
 */
const arbDoc: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  fc.string({ minLength: 1, maxLength: 120 }).map((s) => clampUtf8(s, SC_SPEC_DOC_LIMIT)),
  fc
    .array(
      fc.constantFrom(
        'αβγδε',
        'こんにちは世界',
        '🚀🔒⚡🌐',
        'éàüñçß',
        'مرحبا',
        'Line one.\n\nLine two with <script>alert(1)</script> & "quotes".',
      ),
      { minLength: 1, maxLength: 20 },
    )
    .map((parts) => clampUtf8(parts.join(' '), SC_SPEC_DOC_LIMIT)),
  fc
    .string({ minLength: 400, maxLength: 1024 })
    .map((s) => clampUtf8(s.repeat(3), SC_SPEC_DOC_LIMIT)),
);

const PRIMITIVE_FACTORIES: readonly (() => xdr.ScSpecTypeDef)[] = [
  () => xdr.ScSpecTypeDef.scSpecTypeVal(),
  () => xdr.ScSpecTypeDef.scSpecTypeBool(),
  () => xdr.ScSpecTypeDef.scSpecTypeVoid(),
  () => xdr.ScSpecTypeDef.scSpecTypeError(),
  () => xdr.ScSpecTypeDef.scSpecTypeU32(),
  () => xdr.ScSpecTypeDef.scSpecTypeI32(),
  () => xdr.ScSpecTypeDef.scSpecTypeU64(),
  () => xdr.ScSpecTypeDef.scSpecTypeI64(),
  () => xdr.ScSpecTypeDef.scSpecTypeTimepoint(),
  () => xdr.ScSpecTypeDef.scSpecTypeDuration(),
  () => xdr.ScSpecTypeDef.scSpecTypeU128(),
  () => xdr.ScSpecTypeDef.scSpecTypeI128(),
  () => xdr.ScSpecTypeDef.scSpecTypeU256(),
  () => xdr.ScSpecTypeDef.scSpecTypeI256(),
  () => xdr.ScSpecTypeDef.scSpecTypeBytes(),
  () => xdr.ScSpecTypeDef.scSpecTypeString(),
  () => xdr.ScSpecTypeDef.scSpecTypeSymbol(),
  () => xdr.ScSpecTypeDef.scSpecTypeAddress(),
  () => xdr.ScSpecTypeDef.scSpecTypeMuxedAddress(),
];

const arbLeafTypeDef: fc.Arbitrary<xdr.ScSpecTypeDef> = fc.oneof(
  fc.constantFrom(...PRIMITIVE_FACTORIES).map((fn) => fn()),
  fc
    .integer({ min: 1, max: 64 })
    .map((n) => xdr.ScSpecTypeDef.scSpecTypeBytesN(new xdr.ScSpecTypeBytesN({ n }))),
  arbIdentifier(24).map((name) =>
    xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name })),
  ),
);

/** Recursive `xdr.ScSpecTypeDef` generator up to `maxDepth` (default 6). */
function arbTypeDef(maxDepth: number = 6): fc.Arbitrary<xdr.ScSpecTypeDef> {
  if (maxDepth <= 0) {
    return arbLeafTypeDef;
  }
  const child = fc.memo((n: number) => arbTypeDef(n - 1))(maxDepth);
  return fc.oneof(
    { weight: 3, arbitrary: arbLeafTypeDef },
    {
      weight: 1,
      arbitrary: child.map((valueType) =>
        xdr.ScSpecTypeDef.scSpecTypeOption(new xdr.ScSpecTypeOption({ valueType })),
      ),
    },
    {
      weight: 1,
      arbitrary: fc.tuple(child, child).map(([okType, errorType]) =>
        xdr.ScSpecTypeDef.scSpecTypeResult(new xdr.ScSpecTypeResult({ okType, errorType })),
      ),
    },
    {
      weight: 1,
      arbitrary: child.map((elementType) =>
        xdr.ScSpecTypeDef.scSpecTypeVec(new xdr.ScSpecTypeVec({ elementType })),
      ),
    },
    {
      weight: 1,
      arbitrary: fc.tuple(child, child).map(([keyType, valueType]) =>
        xdr.ScSpecTypeDef.scSpecTypeMap(new xdr.ScSpecTypeMap({ keyType, valueType })),
      ),
    },
    {
      weight: 1,
      arbitrary: fc
        .array(child, { minLength: 0, maxLength: 4 })
        .map((valueTypes) =>
          xdr.ScSpecTypeDef.scSpecTypeTuple(new xdr.ScSpecTypeTuple({ valueTypes })),
        ),
    },
  );
}

const arbFunctionInput: fc.Arbitrary<xdr.ScSpecFunctionInputV0> = fc
  .record({
    doc: arbDoc,
    name: arbIdentifier(24),
    type: arbTypeDef(6),
  })
  .map((fields) => new xdr.ScSpecFunctionInputV0(fields));

const arbFunctionEntry: fc.Arbitrary<xdr.ScSpecEntry> = fc
  .record({
    doc: arbDoc,
    name: fc.oneof(arbIdentifier(24), fc.constant('__constructor')),
    inputs: fc.array(arbFunctionInput, { minLength: 0, maxLength: 5 }),
    outputs: fc.array(arbTypeDef(6), { minLength: 0, maxLength: 1 }),
  })
  .map((fn) => xdr.ScSpecEntry.scSpecEntryFunctionV0(new xdr.ScSpecFunctionV0(fn)));

const arbStructField: fc.Arbitrary<xdr.ScSpecUdtStructFieldV0> = fc
  .record({
    doc: arbDoc,
    name: arbIdentifier(24),
    type: arbTypeDef(6),
  })
  .map((f) => new xdr.ScSpecUdtStructFieldV0(f));

const arbStructEntry: fc.Arbitrary<xdr.ScSpecEntry> = fc
  .record({
    doc: arbDoc,
    lib: fc.constant(''),
    name: arbIdentifier(32),
    fields: fc.array(arbStructField, { minLength: 0, maxLength: 5 }),
  })
  .map((s) => xdr.ScSpecEntry.scSpecEntryUdtStructV0(new xdr.ScSpecUdtStructV0(s)));

const arbUnionCase: fc.Arbitrary<xdr.ScSpecUdtUnionCaseV0> = fc.oneof(
  fc
    .record({
      doc: arbDoc,
      name: arbIdentifier(24),
    })
    .map((v) =>
      xdr.ScSpecUdtUnionCaseV0.scSpecUdtUnionCaseVoidV0(new xdr.ScSpecUdtUnionCaseVoidV0(v)),
    ),
  fc
    .record({
      doc: arbDoc,
      name: arbIdentifier(24),
      type: fc.array(arbTypeDef(5), { minLength: 1, maxLength: 4 }),
    })
    .map((t) =>
      xdr.ScSpecUdtUnionCaseV0.scSpecUdtUnionCaseTupleV0(new xdr.ScSpecUdtUnionCaseTupleV0(t)),
    ),
);

const arbUnionEntry: fc.Arbitrary<xdr.ScSpecEntry> = fc
  .record({
    doc: arbDoc,
    lib: fc.constant(''),
    name: arbIdentifier(32),
    cases: fc.array(arbUnionCase, { minLength: 1, maxLength: 5 }),
  })
  .map((u) => xdr.ScSpecEntry.scSpecEntryUdtUnionV0(new xdr.ScSpecUdtUnionV0(u)));

const arbEnumEntry: fc.Arbitrary<xdr.ScSpecEntry> = fc
  .record({
    doc: arbDoc,
    lib: fc.constant(''),
    name: arbIdentifier(32),
    cases: fc.array(
      fc
        .record({
          doc: arbDoc,
          name: arbIdentifier(24),
          value: fc.integer({ min: 0, max: 0xffff_ffff }),
        })
        .map((c) => new xdr.ScSpecUdtEnumCaseV0(c)),
      { minLength: 1, maxLength: 5 },
    ),
  })
  .map((e) => xdr.ScSpecEntry.scSpecEntryUdtEnumV0(new xdr.ScSpecUdtEnumV0(e)));

const arbErrorEnumEntry: fc.Arbitrary<xdr.ScSpecEntry> = fc
  .record({
    doc: arbDoc,
    lib: fc.constant(''),
    name: arbIdentifier(32),
    cases: fc.array(
      fc
        .record({
          doc: arbDoc,
          name: arbIdentifier(24),
          value: fc.integer({ min: 1, max: 0xffff_ffff }),
        })
        .map((c) => new xdr.ScSpecUdtErrorEnumCaseV0(c)),
      { minLength: 1, maxLength: 5 },
    ),
  })
  .map((e) => xdr.ScSpecEntry.scSpecEntryUdtErrorEnumV0(new xdr.ScSpecUdtErrorEnumV0(e)));

const arbSpecEntry: fc.Arbitrary<xdr.ScSpecEntry> = fc.oneof(
  arbFunctionEntry,
  arbStructEntry,
  arbUnionEntry,
  arbEnumEntry,
  arbErrorEnumEntry,
);

const arbSpecEntries: fc.Arbitrary<xdr.ScSpecEntry[]> = fc.array(arbSpecEntry, {
  minLength: 1,
  maxLength: 12,
});

// ── Property tests ────────────────────────────────────────────────────────

test('property: encoding ScSpecEntry[] into a WASM custom section and parsing round-trips flattened views', () => {
  fc.assert(
    fc.property(arbSpecEntries, (entries) => {
      const wasm = encodeEntriesToWasm(entries);
      const parsed = parseContractSpec(wasm);
      const expected = buildSpecViews(entries);

      assert.deepEqual(parsed.functions, expected.functions);
      assert.deepEqual(parsed.types, expected.types);
      assert.deepEqual(parsed.errors, expected.errors);
      assert.equal(parsed.entries.length, entries.length);
    }),
    { seed: FC_SEED, numRuns: FC_RUNS },
  );
});

function permuteObjectKeys<T>(value: T, seed: number): T {
  if (Array.isArray(value)) {
    return value.map((item, i) => permuteObjectKeys(item, seed + i)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const rotated = entries
      .map(([k, v], idx) => [k, permuteObjectKeys(v, seed + idx)] as const)
      .reverse();
    return Object.fromEntries(rotated) as unknown as T;
  }
  return value;
}

test('property: toSpecJson/fromSpecJson round-trips and canonicalStringify is stable', () => {
  fc.assert(
    fc.property(arbSpecEntries, (entries) => {
      const wasm = encodeEntriesToWasm(entries);
      const spec = parseContractSpec(wasm);
      const json = toSpecJson(spec);
      const restored = fromSpecJson(json);
      const roundTrippedJson = toSpecJson(restored);

      assert.deepEqual(roundTrippedJson, json);
      assert.deepEqual(restored.functions, spec.functions);
      assert.deepEqual(restored.types, spec.types);
      assert.deepEqual(restored.errors, spec.errors);
      assert.equal(restored.wasmHash, spec.wasmHash);
      assert.equal(restored.sdkVersion, spec.sdkVersion);

      const canonical1 = canonicalStringify(json);
      const canonical2 = canonicalStringify(roundTrippedJson);
      const permuted = permuteObjectKeys(json, 1) as SpecJson;
      const canonical3 = canonicalStringify(permuted);

      assert.equal(canonical1, canonical2);
      assert.equal(canonical1, canonical3);
    }),
    { seed: FC_SEED, numRuns: FC_RUNS },
  );
});

// ── Fuzz property over committed fixtures ─────────────────────────────────

type MutationOp =
  | { readonly kind: 'flip'; readonly pos: number; readonly mask: number }
  | { readonly kind: 'truncate'; readonly len: number }
  | { readonly kind: 'insert'; readonly pos: number; readonly bytes: Uint8Array };

const arbMutation: fc.Arbitrary<MutationOp[]> = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constant('flip' as const),
      pos: fc.nat({ max: 100_000 }),
      mask: fc.integer({ min: 1, max: 0xff }),
    }),
    fc.record({
      kind: fc.constant('truncate' as const),
      len: fc.nat({ max: 100_000 }),
    }),
    fc.record({
      kind: fc.constant('insert' as const),
      pos: fc.nat({ max: 100_000 }),
      bytes: fc.uint8Array({ minLength: 1, maxLength: 32 }),
    }),
  ),
  { minLength: 1, maxLength: 6 },
);

function applyMutations(source: Uint8Array, ops: readonly MutationOp[]): Uint8Array {
  let buf = Uint8Array.from(source);
  for (const op of ops) {
    if (op.kind === 'flip') {
      if (buf.length > 0) {
        const idx = op.pos % buf.length;
        buf[idx] = buf[idx]! ^ op.mask;
      }
    } else if (op.kind === 'truncate') {
      const len = buf.length === 0 ? 0 : op.len % (buf.length + 1);
      buf = buf.subarray(0, len);
    } else {
      const idx = buf.length === 0 ? 0 : op.pos % (buf.length + 1);
      const next = new Uint8Array(buf.length + op.bytes.length);
      next.set(buf.subarray(0, idx), 0);
      next.set(op.bytes, idx);
      next.set(buf.subarray(idx), idx + op.bytes.length);
      buf = next;
    }
  }
  return buf;
}

test('fuzz: random mutations of every fixture either parse or throw SpecReadError within 200 ms', () => {
  const fixtureFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.wasm'));
  assert.ok(fixtureFiles.length >= 7, 'loaded all committed WASM fixtures');
  const fixtures = fixtureFiles.map((f) => ({
    name: f,
    bytes: new Uint8Array(readFileSync(join(FIXTURES_DIR, f))),
  }));

  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: fixtures.length - 1 }),
      arbMutation,
      (fixtureIdx, ops) => {
        const target = fixtures[fixtureIdx]!;
        const mutated = applyMutations(target.bytes, ops);
        const start = performance.now();
        try {
          const spec = parseContractSpec(mutated);
          assert.ok(Array.isArray(spec.functions));
          assert.ok(Array.isArray(spec.types));
          assert.ok(Array.isArray(spec.errors));
        } catch (err) {
          assert.ok(
            isSpecReadError(err),
            `mutation on ${target.name} threw non-SpecReadError: ${String(err)}`,
          );
        }
        const elapsed = performance.now() - start;
        assert.ok(
          elapsed <= CASE_BUDGET_MS,
          `mutation on ${target.name} took ${elapsed.toFixed(1)} ms (> ${CASE_BUDGET_MS} ms)`,
        );
      },
    ),
    { seed: FC_SEED, numRuns: FC_RUNS },
  );
});

// ── Adversarial fixtures & explicit caps ──────────────────────────────────

function assertFailsWithinBudgets(
  label: string,
  fn: () => unknown,
  expectedKind?: ConcreteSpecReadError['kind'],
): ConcreteSpecReadError {
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  const elapsed = performance.now() - start;
  const heapDelta = Math.max(0, process.memoryUsage().heapUsed - heapBefore);

  assert.ok(caught !== undefined, `${label}: expected parseContractSpec to throw`);
  assert.ok(
    isSpecReadError(caught),
    `${label}: expected SpecReadError, got ${String(caught)}`,
  );
  if (expectedKind !== undefined) {
    assert.equal(caught.kind, expectedKind, `${label}: expected error kind ${expectedKind}`);
  }
  assert.ok(
    elapsed <= CASE_BUDGET_MS,
    `${label}: took ${elapsed.toFixed(2)} ms (budget ${CASE_BUDGET_MS} ms)`,
  );
  assert.ok(
    heapDelta <= HEAP_CEILING_BYTES,
    `${label}: heapUsed grew by ${heapDelta} bytes (ceiling ${HEAP_CEILING_BYTES} bytes)`,
  );
  return caught;
}

test('adversarial fixtures: every checked-in adversarial WASM fails with SpecReadError within 200 ms and heap ceiling', () => {
  const expectations: Readonly<Record<string, ConcreteSpecReadError['kind']>> = {
    'section_past_end.wasm': 'invalid_wasm',
    'ten_thousand_sections.wasm': 'invalid_wasm',
    'hundred_thousand_entries.wasm': 'invalid_wasm',
    'deep_type_1000.wasm': 'interface_unreadable',
    'truncated_mid_entry.wasm': 'interface_unreadable',
    'two_mb_doc.wasm': 'invalid_wasm',
    'over_size_cap.wasm': 'invalid_wasm',
  };

  const files = readdirSync(ADVERSARIAL_DIR)
    .filter((f) => f.endsWith('.wasm'))
    .sort();
  assert.deepEqual(files, Object.keys(expectations).sort());

  for (const [file, expectedKind] of Object.entries(expectations)) {
    const bytes = new Uint8Array(readFileSync(join(ADVERSARIAL_DIR, file)));
    assertFailsWithinBudgets(file, () => parseContractSpec(bytes), expectedKind);
  }

  // With the module byte cap lifted, `hundred_thousand_entries.wasm` and
  // `two_mb_doc.wasm` reach the spec stream and fail on `MAX_SPEC_ENTRIES`
  // and `SC_SPEC_DOC_LIMIT` respectively (`InterfaceUnreadable`).
  const manyEntries = new Uint8Array(
    readFileSync(join(ADVERSARIAL_DIR, 'hundred_thousand_entries.wasm')),
  );
  const manyErr = assertFailsWithinBudgets(
    'hundred_thousand_entries.wasm (unbounded bytes)',
    () => parseContractSpec(manyEntries, { maxBytes: Infinity }),
    'interface_unreadable',
  );
  assert.ok(manyErr instanceof InterfaceUnreadable);
  assert.match(String((manyErr.cause as Error).message), /exceeds maximum of 1024 entries/);

  const twoMbDoc = new Uint8Array(readFileSync(join(ADVERSARIAL_DIR, 'two_mb_doc.wasm')));
  const docErr = assertFailsWithinBudgets(
    'two_mb_doc.wasm (unbounded bytes)',
    () => parseContractSpec(twoMbDoc, { maxBytes: Infinity }),
    'interface_unreadable',
  );
  assert.ok(docErr instanceof InterfaceUnreadable);
  assert.match(String((docErr.cause as Error).message), /max allowed is 1024/);
});

test('caps: MAX_WASM_BYTES, MAX_WASM_SECTIONS, MAX_SPEC_ENTRIES and MAX_TYPE_DEPTH are enforced', () => {
  assert.equal(MAX_WASM_BYTES, 256 * 1024);
  assert.equal(MAX_WASM_SECTIONS, 1_024);
  assert.equal(MAX_SPEC_ENTRIES, 1_024);
  assert.equal(MAX_TYPE_DEPTH, 32);

  // A module under 256 KB with MAX_SPEC_ENTRIES + 1 entries fails on MAX_SPEC_ENTRIES
  const singleEntry = xdr.ScSpecEntry.scSpecEntryUdtEnumV0(
    new xdr.ScSpecUdtEnumV0({ doc: '', lib: '', name: 'E', cases: [] }),
  ).toXDR();
  const overEntryCapPayload = Buffer.alloc(singleEntry.length * (MAX_SPEC_ENTRIES + 1));
  for (let i = 0; i < MAX_SPEC_ENTRIES + 1; i++) {
    singleEntry.copy(overEntryCapPayload, i * singleEntry.length);
  }
  const overEntryCapWasm = wrapInCustomSection(
    CONTRACT_SPEC_SECTION,
    new Uint8Array(overEntryCapPayload),
  );
  assert.ok(overEntryCapWasm.byteLength < MAX_WASM_BYTES);
  const entryErr = assertFailsWithinBudgets(
    'MAX_SPEC_ENTRIES + 1 under 256 KB',
    () => parseContractSpec(overEntryCapWasm),
    'interface_unreadable',
  );
  assert.match(String((entryErr.cause as Error).message), /exceeds maximum of 1024 entries/);

  // A type nested to MAX_TYPE_DEPTH + 1 (33 levels, below js-xdr's 500-level ceiling)
  // fails our explicit assertEntryTypeDepth guard with InterfaceUnreadable.
  let nestedType: xdr.ScSpecTypeDef = xdr.ScSpecTypeDef.scSpecTypeU32();
  for (let i = 0; i < MAX_TYPE_DEPTH + 1; i++) {
    nestedType = xdr.ScSpecTypeDef.scSpecTypeOption(
      new xdr.ScSpecTypeOption({ valueType: nestedType }),
    );
  }
  const deepEntry = xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc: '',
      name: 'too_deep',
      inputs: [new xdr.ScSpecFunctionInputV0({ doc: '', name: 'x', type: nestedType })],
      outputs: [],
    }),
  );
  const deepWasm = encodeEntriesToWasm([deepEntry]);
  const depthErr = assertFailsWithinBudgets(
    'MAX_TYPE_DEPTH + 1',
    () => parseContractSpec(deepWasm),
    'interface_unreadable',
  );
  assert.match(String((depthErr.cause as Error).message), /exceeds maximum depth of 32/);
});

// ── Named regression tests ────────────────────────────────────────────────

test('regression: custom section nameLength LEB128 cannot read continuation bytes past section end', () => {
  // Custom section of size 1 containing a continuation byte (0x80), followed by
  // a valid standard section [0x01, 0x00]. Must fail as a truncated LEB128 inside
  // the custom section boundary.
  const crafted = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x00, 0x01, 0x80,
    0x01, 0x00,
  ]);
  assert.throws(
    () => readCustomSections(crafted),
    (err: unknown) => err instanceof InvalidWasm,
  );
});

test('regression: toTypeRef decodes Uint8Array UDT names as UTF-8 instead of comma-joined byte numbers', () => {
  const rawName = new Uint8Array([0x42, 0x61, 0x6c, 0x61, 0x6e, 0x63, 0x65]); // "Balance"
  const fakeUdtDef = {
    switch: () => ({ name: 'scSpecTypeUdt' }),
    udt: () => ({ name: () => rawName }),
  } as unknown as xdr.ScSpecTypeDef;

  assert.deepEqual(toTypeRef(fakeUdtDef), { type: 'named', name: 'Balance' });
});

test('regression: toTypeRef degrades ScSpecTypeDef trees deeper than MAX_TYPE_DEPTH to unknown without stack overflow', () => {
  let def: xdr.ScSpecTypeDef = xdr.ScSpecTypeDef.scSpecTypeU32();
  for (let i = 0; i < MAX_TYPE_DEPTH + 10; i++) {
    def = xdr.ScSpecTypeDef.scSpecTypeVec(new xdr.ScSpecTypeVec({ elementType: def }));
  }
  const ref = toTypeRef(def);
  let cursor = ref;
  let depth = 0;
  while (typeof cursor === 'object' && cursor.type === 'vec') {
    cursor = cursor.element;
    depth += 1;
  }
  assert.equal(depth, MAX_TYPE_DEPTH);
  assert.deepEqual(cursor, { type: 'unknown', xdrArm: 'scSpecTypeVec' });
});

test('regression: decodeBuildMeta bounds entry count at MAX_META_ENTRIES', () => {
  const entryBytes = xdr.ScMetaEntry.scMetaV0(
    new xdr.ScMetaV0({ key: 'k', val: 'v' }),
  ).toXDR();
  const buf = Buffer.alloc(entryBytes.length * (MAX_META_ENTRIES + 5));
  for (let i = 0; i < MAX_META_ENTRIES + 5; i++) {
    entryBytes.copy(buf, i * entryBytes.length);
  }
  const res = decodeBuildMeta(new Uint8Array(buf));
  assert.ok('warning' in res);
  assert.match(res.warning, /exceeds maximum of 1024 entries/);
});
