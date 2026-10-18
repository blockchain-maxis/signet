#!/usr/bin/env node
/**
 * Generate the deterministic adversarial WASM fixtures in
 * `packages/spec/fixtures/adversarial/` (#440).
 *
 * Each fixture targets a specific untrusted-WASM bound in `@signet/spec`:
 *
 * 1. `section_past_end.wasm` — custom section length header claims 64 KB while
 *    only 4 bytes follow (`InvalidWasm`).
 * 2. `ten_thousand_sections.wasm` — 10,000 empty custom sections (`[0, 1, 0]`),
 *    exceeding `MAX_WASM_SECTIONS` (`InvalidWasm`).
 * 3. `hundred_thousand_entries.wasm` — a `contractspecv0` section containing
 *    100,000 minimal 20-byte `ScSpecEntry` items (`scSpecEntryUdtEnumV0`),
 *    exceeding both `MAX_WASM_BYTES` by default (`InvalidWasm`) and
 *    `MAX_SPEC_ENTRIES` when the byte cap is lifted (`InterfaceUnreadable`).
 * 4. `deep_type_1000.wasm` — a `contractspecv0` entry whose input
 *    `ScSpecTypeDef` nests `scSpecTypeOption` 1,000 levels deep
 *    (`InterfaceUnreadable`).
 * 5. `truncated_mid_entry.wasm` — a well-framed `contractspecv0` custom section
 *    whose XDR stream ends halfway through an `ScSpecEntry`
 *    (`InterfaceUnreadable`).
 * 6. `two_mb_doc.wasm` — a `contractspecv0` entry carrying a 2 MB XDR doc
 *    string (`0x00200000` length prefix + 2 MB payload), exceeding
 *    `MAX_WASM_BYTES` by default (`InvalidWasm`) and `SC_SPEC_DOC_LIMIT` when
 *    the byte cap is lifted (`InterfaceUnreadable`).
 * 7. `over_size_cap.wasm` — a well-formed WASM module of `MAX_WASM_BYTES + 1`
 *    bytes (262,145 bytes) (`InvalidWasm`).
 *
 * Usage:
 *   node fixture-contracts/scripts/make-adversarial-fixtures.mjs [output-dir]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ?? join(__dirname, '..', '..', 'fixtures', 'adversarial');

const WASM_HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const MAX_WASM_BYTES = 256 * 1024;

function writeLebU32(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function buildCustomSection(name, payload) {
  const nameBuf = Buffer.from(name, 'utf8');
  const namePrefix = writeLebU32(nameBuf.length);
  const bodyLen = namePrefix.length + nameBuf.length + payload.length;
  return Buffer.concat([Buffer.from([0x00]), writeLebU32(bodyLen), namePrefix, nameBuf, payload]);
}

function xdrU32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value >>> 0, 0);
  return buf;
}

function xdrString(str) {
  const raw = Buffer.isBuffer(str) ? str : Buffer.from(str, 'utf8');
  const pad = (4 - (raw.length % 4)) % 4;
  return Buffer.concat([xdrU32(raw.length), raw, Buffer.alloc(pad)]);
}

/** Minimal 20-byte ScSpecEntry: scSpecEntryUdtEnumV0 (3) with empty doc, lib, name, cases. */
function minimalEnumEntryBytes() {
  return Buffer.concat([xdrU32(3), xdrU32(0), xdrU32(0), xdrU32(0), xdrU32(0)]);
}

/** 1. Section length claims 65,536 bytes while only 4 bytes follow. */
function makeSectionPastEnd() {
  return Buffer.concat([
    WASM_HEADER,
    Buffer.from([0x00]),
    writeLebU32(65_536),
    Buffer.from([0x01, 0x61, 0x00, 0x00]),
  ]);
}

/** 2. 10,000 empty custom sections ([0, 1, 0] each). */
function makeTenThousandSections() {
  const single = Buffer.from([0x00, 0x01, 0x00]);
  const body = Buffer.alloc(single.length * 10_000);
  for (let i = 0; i < 10_000; i++) {
    single.copy(body, i * single.length);
  }
  return Buffer.concat([WASM_HEADER, body]);
}

/** 3. contractspecv0 containing 100,000 minimal ScSpecEntry items. */
function makeHundredThousandEntries() {
  const entry = minimalEnumEntryBytes();
  const payload = Buffer.alloc(entry.length * 100_000);
  for (let i = 0; i < 100_000; i++) {
    entry.copy(payload, i * entry.length);
  }
  return Buffer.concat([WASM_HEADER, buildCustomSection('contractspecv0', payload)]);
}

/** 4. ScSpecTypeDef nested to depth 1,000 via scSpecTypeOption (1000) around scSpecTypeU32 (4). */
function makeDeepType1000() {
  const optionChains = Buffer.alloc(4 * 1_000);
  for (let i = 0; i < 1_000; i++) {
    optionChains.writeUInt32BE(1000, i * 4); // scSpecTypeOption = 1000
  }
  const fnEntry = Buffer.concat([
    xdrU32(0), // scSpecEntryFunctionV0 = 0
    xdrString(''), // doc
    xdrString('deep'), // name
    xdrU32(1), // 1 input
    xdrString(''), // input doc
    xdrString('arg'), // input name
    optionChains,
    xdrU32(4), // leaf: scSpecTypeU32 = 4
    xdrU32(0), // 0 outputs
  ]);
  return Buffer.concat([WASM_HEADER, buildCustomSection('contractspecv0', fnEntry)]);
}

/** 5. Truncated XDR mid-entry inside a validly framed contractspecv0 section. */
function makeTruncatedMidEntry() {
  const firstEntry = minimalEnumEntryBytes();
  const secondEntry = Buffer.concat([
    xdrU32(0), // scSpecEntryFunctionV0
    xdrString('Full doc comment before truncation'),
    xdrString('broken_fn'),
    xdrU32(2), // claims 2 inputs, but cuts off mid-input
    xdrString('first input doc'),
  ]);
  const payload = Buffer.concat([firstEntry, secondEntry.subarray(0, secondEntry.length - 6)]);
  return Buffer.concat([WASM_HEADER, buildCustomSection('contractspecv0', payload)]);
}

/** 6. A 2 MB doc string inside contractspecv0. */
function makeTwoMbDoc() {
  const docBytes = Buffer.alloc(2 * 1024 * 1024, 0x61); // 2 MB of 'a'
  const entry = Buffer.concat([
    xdrU32(3), // scSpecEntryUdtEnumV0
    xdrString(docBytes),
    xdrU32(0), // lib
    xdrString('BigDoc'),
    xdrU32(0), // cases
  ]);
  return Buffer.concat([WASM_HEADER, buildCustomSection('contractspecv0', entry)]);
}

/** 7. A module of MAX_WASM_BYTES + 1 bytes (262,145 bytes). */
function makeOverSizeCap() {
  const specSection = buildCustomSection('contractspecv0', minimalEnumEntryBytes());
  const prefixLen = WASM_HEADER.length + specSection.length;
  // Add a padding custom section 'pad' so total module size is MAX_WASM_BYTES + 1.
  const targetTotal = MAX_WASM_BYTES + 1;
  const padName = Buffer.from('pad', 'utf8');
  const padNamePrefix = writeLebU32(padName.length);
  // Estimate section header: 1 byte id + 3 bytes LEB128 size + 1 byte nameLen + 3 bytes name = 8 bytes
  const remainingForPadSection = targetTotal - prefixLen;
  // Section size LEB128 for ~262,100 is 3 bytes (since 16384 <= size < 2097152).
  const payloadLen = remainingForPadSection - 1 - 3 - padNamePrefix.length - padName.length;
  const padSection = buildCustomSection('pad', Buffer.alloc(payloadLen));
  const out = Buffer.concat([WASM_HEADER, specSection, padSection]);
  if (out.length !== targetTotal) {
    throw new Error(`Expected ${targetTotal} bytes, got ${out.length}`);
  }
  return out;
}

mkdirSync(outDir, { recursive: true });

const fixtures = {
  'section_past_end.wasm': makeSectionPastEnd(),
  'ten_thousand_sections.wasm': makeTenThousandSections(),
  'hundred_thousand_entries.wasm': makeHundredThousandEntries(),
  'deep_type_1000.wasm': makeDeepType1000(),
  'truncated_mid_entry.wasm': makeTruncatedMidEntry(),
  'two_mb_doc.wasm': makeTwoMbDoc(),
  'over_size_cap.wasm': makeOverSizeCap(),
};

for (const [name, bytes] of Object.entries(fixtures)) {
  const target = join(outDir, name);
  writeFileSync(target, bytes);
  console.log(`wrote ${name} (${bytes.length} bytes)`);
}
