/**
 * @file apps/web/lib/doc-markdown.ts
 *
 * Safe-subset Markdown for contract doc comments (#474, D-11).
 *
 * Doc comments are written by the contract author, so they are untrusted input
 * rendered on Signet's origin. This parser therefore does NOT convert Markdown
 * to an HTML string. It produces a small typed tree (`DocBlock` / `DocInline`);
 * `renderDocComment` in `contract-docs.ts` turns that tree into React elements,
 * and React escapes every string. Raw HTML is never interpreted: `<img ...>` and
 * `<script>` are just text.
 *
 * Supported subset: paragraphs, headings (demoted at render time), emphasis,
 * strong, inline code, fenced code, bullet/numbered lists, links, and intra-doc
 * links like [`Foo`]. Everything else is literal text.
 *
 * Links keep only `http:` / `https:` targets, and images collapse to
 * `alt (url)` text, so nothing in a doc comment can trigger a fetch.
 */

export type DocInline =
  | { type: 'text'; value: string }
  | { type: 'br' }
  | { type: 'code'; value: string }
  | { type: 'em' | 'strong'; children: DocInline[] }
  | { type: 'link'; href: string; children: DocInline[] }
  | { type: 'ref'; name: string };

export type DocBlock =
  | { type: 'paragraph'; children: DocInline[] }
  | { type: 'heading'; level: number; children: DocInline[] }
  | { type: 'code'; value: string; lang?: string }
  | { type: 'list'; ordered: boolean; items: DocInline[][] };

const MAX_INLINE_DEPTH = 4;
/** Bound on how far a link's `[text]` / `(url)` part is searched, keeping parsing linear-ish. */
const MAX_LINK_PART = 500;
/** Failed `[`/`(` searches allowed per block before brackets are treated as plain text. */
const MAX_FAILED_LINK_SCANS = 20;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function hasControlOrSpace(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Returns the URL only when it is an absolute http(s) URL; otherwise null. */
export function safeHref(raw: string): string | null {
  const candidate = raw.trim();
  if (!candidate || hasControlOrSpace(candidate)) return null;
  if (!/^https?:\/\//i.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

function pushText(out: DocInline[], value: string): void {
  if (!value) return;
  const last = out[out.length - 1];
  if (last && last.type === 'text') last.value += value;
  else out.push({ type: 'text', value });
}

/** Finds the `]` closing the `[` at `open`, honouring nesting; -1 when absent. */
function findClose(src: string, open: number, o: string, c: string, limit: number): number {
  let depth = 0;
  const end = Math.min(src.length, open + limit);
  for (let i = open; i < end; i++) {
    const ch = src[i];
    if (ch === '\\') {
      i++;
    } else if (ch === o) {
      depth++;
    } else if (ch === c) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Parses inline Markdown. Exported for tests. */
export function parseInline(src: string, depth = 0): DocInline[] {
  let failedScans = 0;
  const out: DocInline[] = [];
  let buf = '';
  const flush = () => {
    pushText(out, buf);
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;

    if (ch === '\\' && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!<>|~]/.test(src[i + 1]!)) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      let run = 1;
      while (src[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const close = src.indexOf(fence, i + run);
      if (close !== -1 && close > i + run) {
        flush();
        let value = src.slice(i + run, close);
        if (value.length > 2 && value.startsWith(' ') && value.endsWith(' ')) value = value.slice(1, -1);
        out.push({ type: 'code', value });
        i = close + run;
        continue;
      }
      buf += fence;
      i += run;
      continue;
    }

    const isImage = ch === '!' && src[i + 1] === '[';
    if ((ch === '[' || isImage) && failedScans < MAX_FAILED_LINK_SCANS) {
      const open = isImage ? i + 1 : i;
      const close = findClose(src, open, '[', ']', MAX_LINK_PART);
      if (close !== -1) {
        const label = src.slice(open + 1, close);
        if (src[close + 1] === '(') {
          const pEnd = findClose(src, close + 1, '(', ')', MAX_LINK_PART);
          if (pEnd !== -1) {
            // Drop an optional title: [t](url "title")
            const dest = src.slice(close + 2, pEnd).trim().replace(/\s+(?:"[^"]*"|'[^']*')$/, '');
            const bare = dest.startsWith('<') && dest.endsWith('>') ? dest.slice(1, -1) : dest;
            const href = safeHref(bare);
            flush();
            if (isImage) {
              // Never fetched: alt text plus the URL as text.
              const alt = label.replace(/[*_`[\]]/g, '');
              pushText(out, alt ? `${alt} (${bare})` : bare);
            } else if (href && depth < MAX_INLINE_DEPTH) {
              out.push({ type: 'link', href, children: parseInline(label, depth + 1) });
            } else {
              // Disallowed scheme (javascript:, data:, ...): keep the label as text.
              for (const n of depth < MAX_INLINE_DEPTH ? parseInline(label, depth + 1) : [{ type: 'text' as const, value: label }]) out.push(n);
            }
            i = pEnd + 1;
            continue;
          }
        } else if (!isImage) {
          // Intra-doc link: [`Foo`]
          const m = /^`([A-Za-z_][A-Za-z0-9_]*)`$/.exec(label);
          if (m && IDENT.test(m[1]!)) {
            flush();
            out.push({ type: 'ref', name: m[1]! });
            i = close + 1;
            continue;
          }
        }
      }
      failedScans++;
      buf += isImage ? '![' : '[';
      i = open + 1;
      continue;
    }

    if ((ch === '*' || ch === '_') && depth < MAX_INLINE_DEPTH) {
      const double = src[i + 1] === ch;
      const delim = double ? ch + ch : ch;
      const start = i + delim.length;
      const prev = src[i - 1];
      // `_` inside a word (snake_case) is not emphasis.
      const intraWord = ch === '_' && prev !== undefined && /[A-Za-z0-9]/.test(prev);
      if (!intraWord && start < src.length && !/\s/.test(src[start]!)) {
        const close = src.indexOf(delim, start);
        if (close > start && !/\s/.test(src[close - 1]!)) {
          flush();
          out.push({
            type: double ? 'strong' : 'em',
            children: parseInline(src.slice(start, close), depth + 1),
          });
          i = close + delim.length;
          continue;
        }
      }
      buf += delim;
      i += delim.length;
      continue;
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

function parseLines(lines: string[]): DocInline[] {
  const out: DocInline[] = [];
  lines.forEach((line, idx) => {
    if (idx > 0) out.push({ type: 'br' });
    out.push(...parseInline(line.trim()));
  });
  return out;
}

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;

/**
 * Parses a doc comment into blocks. Returns [] for empty / whitespace-only input.
 * Single newlines inside a paragraph are kept as line breaks, matching the
 * plain-text behaviour from #469.
 */
export function parseDocMarkdown(doc?: string | null): DocBlock[] {
  if (!doc || !doc.trim()) return [];
  const lines = doc.replace(/\r\n?/g, '\n').split('\n');
  const blocks: DocBlock[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ type: 'paragraph', children: parseLines(para) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i]!.trim();
        if (l.startsWith(marker[0]!.repeat(marker.length)) && /^[`~]+$/.test(l)) break;
        body.push(lines[i]!);
        i++;
      }
      blocks.push({ type: 'code', value: body.join('\n'), lang: fence[2] || undefined });
      continue;
    }

    if (!line.trim()) {
      flushPara();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ type: 'heading', level: heading[1]!.length, children: parseInline(heading[2]!) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      flushPara();
      const isOrdered = Boolean(ordered);
      const re = isOrdered ? ORDERED : BULLET;
      const items: DocInline[][] = [];
      let m: RegExpExecArray | null = re.exec(line);
      let j = i;
      while (m) {
        const item = [m[1]!];
        // Indented continuation lines belong to the item.
        while (j + 1 < lines.length && /^\s{2,}\S/.test(lines[j + 1]!) && !re.test(lines[j + 1]!)) {
          j++;
          item.push(lines[j]!);
        }
        items.push(parseLines(item));
        const next = lines[j + 1];
        m = next !== undefined ? re.exec(next) : null;
        if (m) j++;
      }
      blocks.push({ type: 'list', ordered: isOrdered, items });
      i = j;
      continue;
    }

    para.push(line);
  }
  flushPara();
  return blocks;
}
