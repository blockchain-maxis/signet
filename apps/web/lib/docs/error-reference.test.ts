import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContractSpec, toSpecJson, type SpecErrorCase } from '@signet/spec';
import { withFlattenedViews } from '../contract-overview.ts';
import { errorAnchor } from './anchors.ts';
import {
  ON_CHAIN_NOTE,
  SHARED_CODE_NOTE,
  buildErrorReference,
} from './error-reference.ts';

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

function c(enumName: string, name: string, value: number, doc = ''): SpecErrorCase {
  return { enumName, name, value, doc };
}

test('registry fixture: one table with 7 rows, each with its code and name', () => {
  const spec = fixture('identity-registry');
  const reference = buildErrorReference(spec);
  assert.ok(reference);
  assert.equal(reference.tables.length, 1);
  const table = reference.tables[0]!;
  assert.equal(table.rows.length, 7);
  assert.deepEqual(
    table.rows.map((r) => [r.code, r.name]),
    spec.errors.map((e) => [e.value, e.name]),
  );
  assert.deepEqual(
    table.rows.map((r) => r.id),
    spec.errors.map((e) => errorAnchor(e.enumName, e.name)),
  );
  assert.equal(reference.onChainNote, ON_CHAIN_NOTE);
});

test('registry fixture: a single enum has no shared-number note', () => {
  const reference = buildErrorReference(fixture('identity-registry'));
  assert.deepEqual(reference?.sharedCodes, []);
  assert.equal(reference?.sharedNote, null);
});

test('errors_multi fixture: two tables, in declaration order, never merged', () => {
  const spec = fixture('errors_multi');
  const reference = buildErrorReference(spec);
  assert.ok(reference);
  assert.equal(reference.tables.length, 2);
  assert.deepEqual(
    reference.tables.map((t) => t.enumName),
    [...new Set(spec.errors.map((e) => e.enumName))],
  );
  assert.equal(
    reference.tables.reduce((n, t) => n + t.rows.length, 0),
    spec.errors.length,
  );
});

test('errors_multi fixture: the shared-number note agrees with the codes the enums share', () => {
  const spec = fixture('errors_multi');
  const reference = buildErrorReference(spec);
  assert.ok(reference);
  const [a, b] = reference.tables;
  const shared = a!.rows.map((r) => r.code).filter((code) => b!.rows.some((r) => r.code === code));
  assert.deepEqual(reference.sharedCodes, [...new Set(shared)].sort((x, y) => x - y));
  assert.equal(reference.sharedNote, shared.length > 0 ? SHARED_CODE_NOTE : null);
});

test('enums that share a code flag it and show the note; rows keep their own enum', () => {
  const reference = buildErrorReference({
    errors: [c('AuthError', 'Denied', 1), c('AuthError', 'Expired', 2), c('MathError', 'Overflow', 1)],
  });
  assert.ok(reference);
  assert.deepEqual(reference.sharedCodes, [1]);
  assert.equal(reference.sharedNote, SHARED_CODE_NOTE);
  assert.deepEqual(
    reference.tables.map((t) => t.rows.map((r) => r.collides)),
    [[true, false], [true]],
  );
  assert.equal(reference.tables[1]!.rows[0]!.id, 'error-MathError-Overflow');
});

test('enums with distinct codes show no shared-number note', () => {
  const reference = buildErrorReference({
    errors: [c('AuthError', 'Denied', 1), c('MathError', 'Overflow', 100)],
  });
  assert.ok(reference);
  assert.equal(reference.tables.length, 2);
  assert.deepEqual(reference.sharedCodes, []);
  assert.equal(reference.sharedNote, null);
  assert.ok(reference.tables.every((t) => t.rows.every((r) => !r.collides)));
});

test('a contract with no error enum has no section', () => {
  assert.equal(buildErrorReference({ errors: [] }), null);
});

test('a doc comment is passed through as written, and absence stays empty', () => {
  const reference = buildErrorReference({
    errors: [c('E', 'A', 1, 'The handle is taken.'), c('E', 'B', 2)],
  });
  assert.deepEqual(
    reference?.tables[0]!.rows.map((r) => r.doc),
    ['The handle is taken.', ''],
  );
});
