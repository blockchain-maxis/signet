import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContractSpec, toSpecJson } from '@signet/spec';
import { buildFunctionReference } from './function-reference.ts';
import { buildTypeReference } from './type-reference.ts';
import { buildErrorReference } from './error-reference.ts';
import {
  errorRowSearchText,
  formatMatchAnnouncement,
  functionSearchText,
  matchesSearchQuery,
  typeSearchText,
} from './search.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'packages', 'spec', 'fixtures');

function loadTypesZooSpec() {
  const wasm = readFileSync(join(FIXTURES, 'types_zoo.wasm'));
  return toSpecJson(parseContractSpec(wasm));
}

test('functionSearchText indexes function name, argument names, type names, and doc text', () => {
  const spec = loadTypesZooSpec();
  const ref = buildFunctionReference(spec, '/p/dev/contract/C123/types');

  const searchable = ref.functions.map((fn) => ({
    name: fn.name,
    text: functionSearchText(fn),
  }));

  // Filtering by argument name `lasts` matches only `when`
  const byLasts = searchable.filter((s) => matchesSearchQuery(s.text, 'lasts'));
  assert.deepEqual(byLasts.map((s) => s.name), ['when']);

  // Filtering by argument name `fixed` matches only `blobs`
  const byFixed = searchable.filter((s) => matchesSearchQuery(s.text, 'fixed'));
  assert.deepEqual(byFixed.map((s) => s.name), ['blobs']);

  // Filtering by type name `Color` (case-insensitive) matches only `paint`
  const byColor = searchable.filter((s) => matchesSearchQuery(s.text, 'COLOR'));
  assert.deepEqual(byColor.map((s) => s.name), ['paint']);

  // Empty query matches all 14 functions
  const all = searchable.filter((s) => matchesSearchQuery(s.text, '   '));
  assert.equal(all.length, 14);
});

test('typeSearchText and errorRowSearchText index types, fields, variants, and error cases', () => {
  const spec = loadTypesZooSpec();
  const typeRef = buildTypeReference(spec, '/p/dev/contract/C123/types');
  const errRef = buildErrorReference(spec);
  assert.ok(errRef);

  const types = [...typeRef.used, ...typeRef.unused].map((t) => ({
    name: t.name,
    text: typeSearchText(t),
  }));

  const byShape = types.filter((t) => matchesSearchQuery(t.text, 'point'));
  assert.deepEqual(byShape.map((t) => t.name), ['Shape']);

  const errors = errRef.tables.flatMap((table) =>
    table.rows.map((row) => ({
      name: row.name,
      text: errorRowSearchText(table.enumName, row),
    })),
  );
  assert.equal(errors.length, 1);
  assert.ok(matchesSearchQuery(errors[0]!.text, 'outofrange'));
  assert.ok(matchesSearchQuery(errors[0]!.text, 'zooerror'));
});

test('formatMatchAnnouncement returns a readable count string', () => {
  assert.equal(formatMatchAnnouncement(1, 14, 'functions'), '1 of 14 functions matching');
  assert.equal(formatMatchAnnouncement(0, 5, 'items'), '0 of 5 items matching');
});
