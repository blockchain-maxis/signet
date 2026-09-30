import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderDocComment, docRefsFromSpec } from './contract-docs.ts';
import { parseDocMarkdown, safeHref } from './doc-markdown.ts';

const html = (doc: string, refs?: Parameters<typeof renderDocComment>[1]) => {
  const el = renderDocComment(doc, refs);
  assert.ok(el);
  return renderToStaticMarkup(el);
};

test('renders the safe subset: emphasis, inline code, fenced code, lists', () => {
  const out = html('A *soft* and **hard** `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n```rust\nlet a = 1 < 2;\n```');
  assert.match(out, /<em>soft<\/em>/);
  assert.match(out, /<strong[^>]*>hard<\/strong>/);
  assert.match(out, /<code[^>]*>code<\/code>/);
  assert.match(out, /<ul[^>]*><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(out, /<ol[^>]*><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(out, /<pre[^>]*><code>let a = 1 &lt; 2;<\/code><\/pre>/);
});

test('plain text still renders as before: paragraphs and <br/>', () => {
  assert.match(html('Line 1\nLine 2'), /^<p[^>]*>Line 1<br\/>Line 2<\/p>$/);
});

test('raw HTML is inert text: <img onerror>, <iframe>, <script>', () => {
  const out = html('<img src=x onerror=alert(1)> <iframe src="https://evil.test"></iframe> <script>alert(1)</script>');
  assert.ok(!/<img|<iframe|<script/i.test(out), out);
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(out.includes('&lt;iframe'));
});

test('raw HTML inside code and link labels stays escaped', () => {
  const out = html('`<b>x</b>` and [<img src=x onerror=alert(1)>](https://example.com)');
  assert.ok(!/<b>|<img/.test(out), out);
});

test('links: http(s) only, with rel="nofollow ugc noopener"', () => {
  const out = html('[docs](https://example.com/a?b=1) and [plain](http://example.com)');
  assert.match(out, /<a [^>]*href="https:\/\/example.com\/a\?b=1"/);
  assert.equal((out.match(/rel="nofollow ugc noopener"/g) ?? []).length, 2);
});

test('javascript:, data:, vbscript: and relative link targets render as text', () => {
  for (const target of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    '//evil.test/x',
    '/relative',
    'ftp://example.com/x',
  ]) {
    const out = html(`[click me](${target})`);
    assert.ok(!out.includes('<a'), `${target}: ${out}`);
    assert.ok(!out.includes('href'), `${target}: ${out}`);
    assert.ok(out.includes('click me'));
  }
});

test('autolink-style <https://…> and bare URLs are text, not links', () => {
  const out = html('<javascript:alert(1)> <https://example.com> https://example.com');
  assert.ok(!out.includes('<a'), out);
});

test('images render as alt text plus the URL, never as <img>', () => {
  const out = html('![tracking pixel](https://tracker.test/p.gif)');
  assert.ok(!out.includes('<img'), out);
  assert.ok(out.includes('tracking pixel (https://tracker.test/p.gif)'));
  const data = html('![x](data:image/png;base64,AAAA)');
  assert.ok(!data.includes('<img') && !data.includes('src='), data);
});

test('headings are demoted below the page heading levels', () => {
  const out = html('# One\n\n## Two\n\n###### Six');
  assert.ok(!/<h[123][ >]/.test(out), out);
  assert.match(out, /<h4[^>]*>One<\/h4>/);
  assert.match(out, /<h5[^>]*>Two<\/h5>/);
  assert.match(out, /<h6[^>]*>Six<\/h6>/);
});

test('intra-doc links resolve to type and error anchors, else plain code', () => {
  const refs = docRefsFromSpec(
    { types: [{ name: 'Foo' }], errors: [{ name: 'HandleTaken' }] },
    '/p/dev/contract/CABC/types',
  );
  const out = html('See [`Foo`], [`HandleTaken`] and [`Unknown`].', { refs });
  assert.match(out, /<a [^>]*href="\/p\/dev\/contract\/CABC\/types#type-Foo"[^>]*><code[^>]*>Foo<\/code><\/a>/);
  assert.match(out, /href="\/p\/dev\/contract\/CABC\/types#error-HandleTaken"/);
  assert.match(out, /<code[^>]*>Unknown<\/code>/);
  assert.equal((out.match(/<a /g) ?? []).length, 2);
  // Without refs: plain code.
  assert.ok(!html('[`Foo`]').includes('<a'));
});

test('a 10,000-character comment parses quickly and renders inert', () => {
  for (const doc of [
    'a'.repeat(10_000),
    '<script>'.repeat(1250),
    '['.repeat(10_000),
    '*'.repeat(10_000),
    '`'.repeat(10_000),
    '[a]('.repeat(2000),
    '**a *b _c '.repeat(1000),
    '- x\n'.repeat(2000),
  ]) {
    const t = Date.now();
    const out = html(doc);
    assert.ok(Date.now() - t < 4000, "rendering must stay fast (quadratic parsing regression)");
    assert.ok(!/<script|<img|<iframe|href=/.test(out));
  }
});

test('safeHref only allows http and https', () => {
  assert.equal(safeHref('https://example.com'), 'https://example.com/');
  assert.equal(safeHref('http://example.com/x'), 'http://example.com/x');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('https://exa mple.com'), null);
  assert.equal(safeHref(''), null);
});

test('empty and whitespace docs produce no blocks', () => {
  assert.deepEqual(parseDocMarkdown('  \n\n '), []);
  assert.equal(renderDocComment('  '), null);
});
