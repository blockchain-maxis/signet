import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContractSpec, toSpecJson } from '@signet/spec';
import { withFlattenedViews } from '../contract-overview.ts';
import { errorAnchor, fnAnchor, typeAnchor } from './anchors.ts';
import { buildErrorReference, type ErrorTable } from './error-reference.ts';
import { buildTypeReference } from './type-reference.ts';
import { buildFunctionReference, typesTabHref } from './function-reference.ts';
import { buildFunctionsToc, buildTypesToc } from './toc.ts';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'spec',
  'fixtures',
);

function fixture(name: string) {
  return withFlattenedViews(
    toSpecJson(parseContractSpec(readFileSync(join(FIXTURES, `${name}.wasm`)))),
  );
}

test('types_zoo: every function heading carries the id fnAnchor returns', () => {
  const spec = fixture('types_zoo');
  const ref = buildFunctionReference(spec, typesTabHref('dev', 'CABC'));
  const allFunctions = [
    ...(ref.ctor ? [ref.ctor] : []),
    ...ref.functions,
  ];

  assert.ok(allFunctions.length > 0, 'types_zoo has functions');

  for (const fn of allFunctions) {
    const expectedId = fnAnchor(fn.name);
    assert.equal(fn.id, expectedId, `Expected function section id to be ${expectedId}`);
  }

  const toc = buildFunctionsToc(spec, typesTabHref('dev', 'CABC'));
  assert.equal(toc.length, allFunctions.length);
  for (let i = 0; i < allFunctions.length; i++) {
    const fn = allFunctions[i]!;
    assert.equal(toc[i]!.title, fn.name);
    assert.equal(toc[i]!.href, `#${fnAnchor(fn.name)}`);
    assert.equal(toc[i]!.id, fnAnchor(fn.name));
  }
});

test('types_zoo: every type heading carries the id typeAnchor returns', () => {
  const spec = fixture('types_zoo');
  const ref = buildTypeReference(spec, typesTabHref('dev', 'CABC'));

  assert.ok(ref.used.length > 0, 'types_zoo has used types');

  for (const type of ref.used) {
    const expectedId = typeAnchor(type.name);
    assert.equal(type.id, expectedId, `Expected type section id to be ${expectedId}`);
  }

  const toc = buildTypesToc(spec, typesTabHref('dev', 'CABC'));
  const typeTocItems = toc.slice(0, ref.used.length);
  assert.equal(typeTocItems.length, ref.used.length);
  for (let i = 0; i < ref.used.length; i++) {
    const t = ref.used[i]!;
    assert.equal(typeTocItems[i]!.title, t.name);
    assert.equal(typeTocItems[i]!.href, `#${typeAnchor(t.name)}`);
    assert.equal(typeTocItems[i]!.id, typeAnchor(t.name));
  }
});

test('types_zoo: every error heading carries the id errorAnchor returns', () => {
  const spec = fixture('types_zoo');
  const errorRef = buildErrorReference(spec);

  assert.ok(errorRef, 'types_zoo has error reference');
  assert.ok(errorRef.tables.length > 0, 'types_zoo has error tables');

  for (const table of errorRef.tables) {
    const expectedEnumId = errorAnchor(table.enumName);
    assert.equal(expectedEnumId, `error-${table.enumName}`);

    for (const row of table.rows) {
      const expectedRowId = errorAnchor(table.enumName, row.name);
      assert.equal(row.id, expectedRowId);
    }
  }

  const toc = buildTypesToc(spec, typesTabHref('dev', 'CABC'));
  const typeRef = buildTypeReference(spec, typesTabHref('dev', 'CABC'));
  const errorTocItems = toc.slice(typeRef.used.length);
  assert.equal(errorTocItems.length, errorRef.tables.length);

  for (let i = 0; i < errorRef.tables.length; i++) {
    const table: ErrorTable = errorRef.tables[i]!;
    assert.equal(errorTocItems[i]!.title, table.enumName);
    assert.equal(errorTocItems[i]!.href, `#${errorAnchor(table.enumName)}`);
    assert.equal(errorTocItems[i]!.id, errorAnchor(table.enumName));
  }
});
