import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { contract } from '@stellar/stellar-sdk';
import {
  NO_DOC_COMMENTS_NOTE,
  parseDocCommentParagraphs,
  hasAnyDocComments,
  renderDocComment,
  renderNoDocCommentsNote,
  renderFunctionList,
  formatFunctionSignature,
  type ContractSpecLike,
} from './contract-docs.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'packages', 'spec', 'fixtures');
const DOCS_COMPONENTS_DIR = join(
  __dirname,
  '..',
  'app',
  'p',
  '[handle]',
  'contract',
  '[address]',
  '_docs',
);

/**
 * Helper to decode a WASM fixture's contractspecv0 section into a ContractSpecLike.
 */
function decodeWasmSpec(wasmBytes: Buffer): ContractSpecLike {
  const mod = new WebAssembly.Module(new Uint8Array(wasmBytes));
  const sections = WebAssembly.Module.customSections(mod, 'contractspecv0');
  if (sections.length === 0) {
    return { functions: [], types: [], errors: [] };
  }
  const spec = new contract.Spec(Buffer.from(sections[0]!));

  const functions = spec.funcs().map((f) => ({
    name: f.name().toString(),
    doc: f.doc().toString() || undefined,
    inputs: f.inputs().map((i) => ({
      name: i.name().toString(),
      doc: i.doc().toString() || undefined,
    })),
    outputs: [],
  }));

  const errors = spec.errorCases().map((e) => {
    const attrs = (e as any)._attributes ?? {};
    const name = attrs.name ? attrs.name.toString() : '';
    const doc = attrs.doc ? attrs.doc.toString() : '';
    const value = typeof attrs.value === 'number' ? attrs.value : 0;
    return {
      name,
      doc: doc || undefined,
      value,
    };
  });

  return {
    functions,
    types: [],
    errors,
  };
}

// ---------------------------------------------------------------------------
// 1. Doc comments plain text parsing and formatting
// ---------------------------------------------------------------------------

test('parseDocCommentParagraphs: returns empty array for empty, undefined, or whitespace string', () => {
  assert.deepEqual(parseDocCommentParagraphs(), []);
  assert.deepEqual(parseDocCommentParagraphs(null), []);
  assert.deepEqual(parseDocCommentParagraphs(''), []);
  assert.deepEqual(parseDocCommentParagraphs('   \n  \t  \n  '), []);
});

test('parseDocCommentParagraphs: splits on blank lines and preserves single newlines', () => {
  const input =
    'First paragraph, line 1.\nFirst paragraph, line 2.\n\nSecond paragraph, line 1.\nSecond paragraph, line 2.';
  const result = parseDocCommentParagraphs(input);

  assert.equal(result.length, 2);
  assert.deepEqual(result[0], ['First paragraph, line 1.', 'First paragraph, line 2.']);
  assert.deepEqual(result[1], ['Second paragraph, line 1.', 'Second paragraph, line 2.']);
});

test('parseDocCommentParagraphs: ignores leading, trailing, and multiple consecutive blank lines', () => {
  const input = '\n\n\nFirst paragraph.\n\n\n\nSecond paragraph.\n\n\n';
  const result = parseDocCommentParagraphs(input);

  assert.equal(result.length, 2);
  assert.deepEqual(result[0], ['First paragraph.']);
  assert.deepEqual(result[1], ['Second paragraph.']);
});

test('renderDocComment: returns null for empty or whitespace doc (never an empty <p>)', () => {
  assert.equal(renderDocComment(undefined), null);
  assert.equal(renderDocComment(null), null);
  assert.equal(renderDocComment(''), null);
  assert.equal(renderDocComment('   \n\n   '), null);
});

test('renderDocComment: renders a single paragraph with single newlines joined with <br />', () => {
  const input = 'Line 1 of docs\nLine 2 of docs';
  const element = renderDocComment(input);
  assert.ok(element !== null);

  const html = renderToStaticMarkup(element);
  assert.ok(html.startsWith('<p'));
  assert.ok(html.includes('Line 1 of docs<br/>Line 2 of docs'));
  assert.ok(!html.includes('<p></p>'));
});

test('renderDocComment: renders multiple paragraphs separated by blank lines', () => {
  const input = 'Paragraph one\n\nParagraph two';
  const element = renderDocComment(input);
  assert.ok(element !== null);

  const html = renderToStaticMarkup(element);
  assert.ok(html.includes('<p'));
  const pCount = (html.match(/<p/g) || []).length;
  assert.equal(pCount, 2);
  assert.ok(html.includes('Paragraph one'));
  assert.ok(html.includes('Paragraph two'));
});

// ---------------------------------------------------------------------------
// 2. HTML escaping / Literal text safety
// ---------------------------------------------------------------------------

test('renderDocComment: renders <script> and HTML tags as literal escaped text', () => {
  const input = '<script>alert("xss")</script> and <img src=x onerror=alert(1)>';
  const element = renderDocComment(input);
  assert.ok(element !== null);

  const html = renderToStaticMarkup(element);

  // Must NOT contain literal unescaped tags
  assert.ok(!html.includes('<script>'), 'must not contain raw <script>');
  assert.ok(!html.includes('<img'), 'must not contain raw <img');

  // Must contain properly escaped HTML entities
  assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;') || html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;') || html.includes('&lt;img'));
});

// ---------------------------------------------------------------------------
// 3. hasAnyDocComments detection logic
// ---------------------------------------------------------------------------

test('hasAnyDocComments: returns false when spec is empty or undefined', () => {
  assert.equal(hasAnyDocComments(undefined), false);
  assert.equal(hasAnyDocComments(null), false);
  assert.equal(hasAnyDocComments({}), false);
  assert.equal(hasAnyDocComments({ functions: [], types: [], errors: [] }), false);
});

test('hasAnyDocComments: returns false when functions have empty or whitespace docs', () => {
  const spec: ContractSpecLike = {
    functions: [
      { name: 'fn1', doc: '' },
      { name: 'fn2', doc: undefined },
      { name: 'fn3', doc: '   ' },
    ],
    types: [],
    errors: [],
  };
  assert.equal(hasAnyDocComments(spec), false);
});

test('hasAnyDocComments: returns true when at least one function has doc comments', () => {
  const spec: ContractSpecLike = {
    functions: [
      { name: 'fn1', doc: '' },
      { name: 'fn2', doc: 'Documented function' },
    ],
  };
  assert.equal(hasAnyDocComments(spec), true);
});

test('hasAnyDocComments: returns true when zero functions have docs but a type has doc comments', () => {
  const spec: ContractSpecLike = {
    functions: [{ name: 'fn1', doc: '' }],
    types: [{ kind: 'struct', name: 'UserConfig', doc: 'Configuration struct' }],
    errors: [],
  };
  assert.equal(hasAnyDocComments(spec), true);
});

test('hasAnyDocComments: returns true when zero functions have docs but a struct field has doc comments', () => {
  const spec: ContractSpecLike = {
    functions: [{ name: 'fn1', doc: '' }],
    types: [
      {
        kind: 'struct',
        name: 'UserConfig',
        fields: [{ name: 'admin', doc: 'The admin key' }],
      },
    ],
    errors: [],
  };
  assert.equal(hasAnyDocComments(spec), true);
});

test('hasAnyDocComments: returns true when zero functions/types have docs but an error has doc comments', () => {
  const spec: ContractSpecLike = {
    functions: [{ name: 'fn1', doc: '' }],
    types: [],
    errors: [{ name: 'NotFound', doc: 'Resource not found error', value: 1 }],
  };
  assert.equal(hasAnyDocComments(spec), true);
});

// ---------------------------------------------------------------------------
// 4. Acceptance Criteria: undocumented.wasm vs identity-registry.wasm
// ---------------------------------------------------------------------------

test('undocumented.wasm acceptance: shows the note once and no function has an empty paragraph', () => {
  const wasmPath = join(FIXTURES_DIR, 'undocumented.wasm');
  const wasmBytes = readFileSync(wasmPath);
  const spec = decodeWasmSpec(wasmBytes);

  // 1. Verify fixture spec has zero doc comments
  assert.equal(spec.functions?.length, 3);
  assert.equal(hasAnyDocComments(spec), false, 'undocumented.wasm must have zero doc comments');

  // 2. Render Functions tab
  const element = renderFunctionList(spec);
  const html = renderToStaticMarkup(element);

  // 3. Shows the note once
  const escapedNote = NO_DOC_COMMENTS_NOTE.replace(/'/g, '&#x27;');
  const noteMatches =
    (html.split(NO_DOC_COMMENTS_NOTE).length - 1) +
    (html.split(escapedNote).length - 1);
  assert.equal(noteMatches, 1, 'note must appear exactly once');

  // 4. No function has an empty paragraph element (<p></p> or <p ...></p>)
  const emptyParagraphRegex = /<p[^>]*>\s*<\/p>/i;
  assert.equal(
    emptyParagraphRegex.test(html),
    false,
    'no empty paragraph element <p></p> may be rendered',
  );

  // 5. All functions are rendered with their signatures
  assert.ok(html.includes('add('), 'renders add function');
  assert.ok(html.includes('ping('), 'renders ping function');
  assert.ok(html.includes('greet('), 'renders greet function');
});

test('identity-registry.wasm acceptance: shows NO note and renders doc comments', () => {
  const wasmPath = join(FIXTURES_DIR, 'identity-registry.wasm');
  const wasmBytes = readFileSync(wasmPath);
  const spec = decodeWasmSpec(wasmBytes);

  // 1. Verify fixture has doc comments
  assert.equal(spec.functions?.length, 8);
  assert.equal(hasAnyDocComments(spec), true, 'identity-registry must have doc comments');

  // 2. Render Functions tab
  const element = renderFunctionList(spec);
  const html = renderToStaticMarkup(element);

  // 3. Shows NO note
  const escapedNote = NO_DOC_COMMENTS_NOTE.replace(/'/g, '&#x27;');
  assert.equal(
    html.includes(NO_DOC_COMMENTS_NOTE) || html.includes(escapedNote),
    false,
    'registry render must show no note',
  );

  // 4. Doc comments for functions are present
  assert.ok(html.includes('claim('), 'renders claim function');
  assert.ok(
    /Bind <code[^>]*>handle<\/code> to <code[^>]*>wallet<\/code>/.test(html),
    'claim doc comment must be rendered',
  );
  assert.ok(html.includes('Reverse lookup: the handle a wallet owns, if any.'));

  // 5. No function has an empty paragraph element
  const emptyParagraphRegex = /<p[^>]*>\s*<\/p>/i;
  assert.equal(
    emptyParagraphRegex.test(html),
    false,
    'no empty paragraph element <p></p> may be rendered',
  );
});

test('Partial documentation acceptance: contract with 1 documented and 2 undocumented functions gets NO note', () => {
  const spec: ContractSpecLike = {
    functions: [
      { name: 'documented_fn', doc: 'This function is documented.' },
      { name: 'undocumented_fn_1' },
      { name: 'undocumented_fn_2', doc: '' },
    ],
  };

  assert.equal(hasAnyDocComments(spec), true);

  const element = renderFunctionList(spec);
  const html = renderToStaticMarkup(element);

  // Shows NO note
  const escapedNote = NO_DOC_COMMENTS_NOTE.replace(/'/g, '&#x27;');
  assert.equal(
    html.includes(NO_DOC_COMMENTS_NOTE) || html.includes(escapedNote),
    false,
    'partial documentation must get no note',
  );

  // Documented function renders doc
  assert.ok(html.includes('This function is documented.'));

  // Undocumented functions render no empty paragraph
  const emptyParagraphRegex = /<p[^>]*>\s*<\/p>/i;
  assert.equal(emptyParagraphRegex.test(html), false);
});

// ---------------------------------------------------------------------------
// 5. Lint-style prevention test against banned placeholder strings
// ---------------------------------------------------------------------------

test('Lint: no docs component contains "No description" or "Description unavailable"', () => {
  const bannedPatterns = [
    /No description/i,
    /Description unavailable/i,
  ];

  function getFilesRecursively(dir: string): string[] {
    const results: string[] = [];
    const list = readdirSync(dir);
    for (const file of list) {
      const fullPath = join(dir, file);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...getFilesRecursively(fullPath));
      } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const docsFiles = getFilesRecursively(DOCS_COMPONENTS_DIR);
  assert.ok(docsFiles.length > 0, 'must find docs component files to lint');

  // Also include the core helper file
  const coreDocsFile = join(__dirname, 'contract-docs.ts');
  docsFiles.push(coreDocsFile);

  for (const filePath of docsFiles) {
    const content = readFileSync(filePath, 'utf8');

    for (const pattern of bannedPatterns) {
      const match = content.match(pattern);
      assert.equal(
        match,
        null,
        `Docs file ${filePath} must not contain forbidden placeholder string: "${match?.[0]}"`,
      );
    }
  }
});
