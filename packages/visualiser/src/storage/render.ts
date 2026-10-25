/**
 * @file The storage layout view (issue 515): the storage slots a contract has
 * been seen using, grouped by durability, and the functions that read and
 * wrote each one (CONTRACT_VISUALISER_DESIGN.md §1.3, phase 3's first half).
 *
 * Everything here is observed, never declared. Soroban contracts have no
 * storage schema, so the heading says which calls the slots come from and
 * that keys those calls never touched are not shown, and every edge is a
 * dashed observed edge: a filled arrowhead where the function changed a key
 * of the slot, an open one where it only read.
 *
 * Pure: plain data in, an SVG or HTML string out, colours only from the
 * `--viz-*` tokens (inlined for a standalone export).
 */

import type { StorageDurability, StorageSlot } from '@signet/spec';
import { textWidth, truncateLabel } from '../metrics.ts';
import { generateInlineTokensStyle, VIZ_CSS_VARIABLES, type VizTheme, type VizTokenName } from '../tokens.ts';
import {
  dashArray,
  EDGE_VOCABULARY,
  markerGlyph,
  markerId,
  nodeShapeSvg,
  renderLegend,
  type EdgeKind,
} from '../vocabulary.ts';

/** One key of the instance entry, as the server read it (issue 514). */
export interface InstanceEntryView {
  readonly key: string;
  readonly shape: string;
  readonly specType?: string;
  readonly valueType: string;
  readonly valuePreview: string;
}

/** The instance entry at a ledger, or why it could not be read. */
export type InstanceView =
  | { readonly ledger: number; readonly entries: readonly InstanceEntryView[] }
  | { readonly ledger: number | null; readonly reason: string };

/** What the storage view draws: observed slots, and the instance entry. */
export interface StorageViewInput {
  readonly slots: readonly StorageSlot[];
  /** Calls the slots were observed in, and their ledger range. */
  readonly observations: number;
  readonly firstLedger: number | null;
  readonly lastLedger: number | null;
  readonly instance?: InstanceView | null;
}

export interface StorageRenderOptions {
  /** Prefix for every element id, so two diagrams on a page do not collide. */
  readonly idPrefix: string;
  readonly title: string;
  /** A node to focus: `fn:<name>` or a slot id, `slot:persistent:Balance(Address)`. */
  readonly focus?: string;
  /** The spec type's page, for a slot whose key matched a spec union or enum. */
  readonly hrefForType?: (name: string) => string | null;
  readonly hrefForFunction?: (name: string) => string | null;
  /**
   * A standalone export: the tokens of this theme inlined, on a ground rect;
   * `auto` inlines both and follows the viewer's colour scheme.
   */
  readonly theme?: VizTheme | 'auto';
}

export const DURABILITY_ORDER: readonly StorageDurability[] = ['instance', 'persistent', 'temporary'];

const FONT_PX = 13;
const SMALL_PX = 11;
const PAD = 24;
const LINE = 18;
const FN_HEIGHT = 28;
const SLOT_HEIGHT = 44;
const ENTRY_HEIGHT = 20;
const GROUP_HEAD = 28;
const GAP = 10;
const GROUP_GAP = 18;
const COLUMN_GAP = 180;
const MAX_FN_CELLS = 32;
const MAX_SLOT_CELLS = 48;
const HEADING_CELLS = 100;
const LEGEND_KINDS = ['function', 'observed', 'observed-write'] as const;

/** A slot's node id, the one `?focus=` names. */
export function slotId(slot: Pick<StorageSlot, 'durability' | 'shape'>): string {
  return `slot:${slot.durability}:${slot.shape}`;
}

/** The heading the view states at every size, and the outline repeats. */
export function storageHeading(input: StorageViewInput): string {
  const { observations: n, firstLedger: a, lastLedger: b } = input;
  const range =
    a !== null && b !== null ? (a === b ? ` (ledger ${a})` : ` (ledgers ${a}–${b})`) : '';
  const instance =
    input.instance && 'entries' in input.instance
      ? ` and the instance entry at ledger ${input.instance.ledger}`
      : '';
  return (
    `Storage seen in ${n} observed call${n === 1 ? '' : 's'}${range}${instance}. ` +
    "Soroban contracts don't declare a storage schema, so keys this contract never touched in those calls aren't shown."
  );
}

function cssVar(token: VizTokenName): string {
  return `var(${VIZ_CSS_VARIABLES[token]})`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : word.endsWith('s') ? 'es' : 's'}`;
}

function wrap(text: string, cells: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > cells) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** One access of a slot by a function: a write wins over a read. */
interface Access {
  readonly fn: string;
  readonly slot: string;
  readonly kind: Extract<EdgeKind, 'observed' | 'observed-write'>;
}

function accessesOf(slots: readonly StorageSlot[]): Access[] {
  const out: Access[] = [];
  for (const slot of slots) {
    const id = slotId(slot);
    for (const fn of slot.writtenBy) out.push({ fn, slot: id, kind: 'observed-write' });
    for (const fn of slot.readBy) {
      if (!slot.writtenBy.includes(fn)) out.push({ fn, slot: id, kind: 'observed' });
    }
  }
  return out;
}

/** What was seen of a slot, in a sentence without its name. */
function slotFacts(slot: StorageSlot, withType = true): string {
  const seen =
    slot.firstSeenLedger === slot.lastSeenLedger
      ? `at ledger ${slot.firstSeenLedger}`
      : `between ledgers ${slot.firstSeenLedger} and ${slot.lastSeenLedger}`;
  const parts = [`${plural(slot.distinctKeys, 'distinct key')} seen ${seen}`];
  if (slot.writtenBy.length) parts.push(`written by ${slot.writtenBy.join(', ')}`);
  const readOnly = slot.readBy.filter((fn) => !slot.writtenBy.includes(fn));
  if (readOnly.length) parts.push(`read by ${readOnly.join(', ')}`);
  if (withType && slot.specType) parts.push(`key matches spec type ${slot.specType}`);
  return `${parts.join('; ')}.`;
}

function slotTitle(slot: StorageSlot): string {
  return `${slot.shape}, ${slot.durability}: ${slotFacts(slot)}`;
}

interface Placed {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The storage view as an SVG: functions on the left, the slots they touched
 * on the right, grouped by durability, with the instance entry's keys listed
 * inside the `instance` group.
 */
export function renderStorageSvg(input: StorageViewInput, opts: StorageRenderOptions): string {
  const prefix = opts.idPrefix;
  const slots = [...input.slots].sort(
    (a, b) =>
      DURABILITY_ORDER.indexOf(a.durability) - DURABILITY_ORDER.indexOf(b.durability) ||
      (a.shape < b.shape ? -1 : a.shape > b.shape ? 1 : 0),
  );
  const accesses = accessesOf(slots);
  const slotIndex = new Map(slots.map((slot, i) => [slotId(slot), i]));

  // Functions in the order of the slots they touch, so edges cross least.
  const touched = new Map<string, number[]>();
  for (const a of accesses) {
    const list = touched.get(a.fn) ?? [];
    list.push(slotIndex.get(a.slot)!);
    touched.set(a.fn, list);
  }
  const centre = (fn: string) => {
    const list = touched.get(fn)!;
    return list.reduce((sum, i) => sum + i, 0) / list.length;
  };
  const functions = [...touched.keys()].sort((a, b) => centre(a) - centre(b) || (a < b ? -1 : a > b ? 1 : 0));

  const instance = input.instance ?? null;
  const entries = instance && 'entries' in instance ? instance.entries : [];
  const entryText = (e: InstanceEntryView) =>
    truncateLabel(`${e.shape} = ${e.valuePreview}`, MAX_SLOT_CELLS + 8);
  const groups = DURABILITY_ORDER.filter(
    (d) => slots.some((s) => s.durability === d) || (d === 'instance' && instance !== null),
  );

  // Column widths.
  const fnWidth = Math.ceil(
    Math.max(140, ...functions.map((fn) => textWidth(truncateLabel(fn, MAX_FN_CELLS), FONT_PX) + 24)),
  );
  const slotLabel = (slot: StorageSlot) => truncateLabel(slot.shape, MAX_SLOT_CELLS);
  const slotMeta = (slot: StorageSlot) =>
    `${plural(slot.distinctKeys, 'distinct key')}${slot.specType ? ' · type ' : ''}`;
  const slotWidth = Math.ceil(
    Math.max(
      260,
      ...slots.map((s) => textWidth(slotLabel(s), FONT_PX) + 24),
      ...slots.map((s) => textWidth(slotMeta(s) + (s.specType ?? ''), SMALL_PX) + 24),
      ...entries.map((e) => textWidth(entryText(e), SMALL_PX) + 24),
      instance && 'reason' in instance ? textWidth(truncateLabel(instance.reason, 80), SMALL_PX) + 24 : 0,
    ),
  );
  const fnX = PAD;
  const slotX = fnX + fnWidth + COLUMN_GAP;
  const contentWidth = slotX + slotWidth + PAD;
  const headingLines = wrap(storageHeading(input), Math.max(HEADING_CELLS, Math.floor((contentWidth - 2 * PAD) / (0.6 * SMALL_PX))));
  const top = PAD + headingLines.length * LINE + 12;

  // Right column: groups, their slots, and the instance entry's keys.
  const slotPos = new Map<string, Placed>();
  const groupBoxes: { durability: StorageDurability; y: number; height: number }[] = [];
  let y = top;
  for (const durability of groups) {
    const start = y;
    y += GROUP_HEAD;
    for (const slot of slots.filter((s) => s.durability === durability)) {
      slotPos.set(slotId(slot), { x: slotX + 8, y, width: slotWidth - 16, height: SLOT_HEIGHT });
      y += SLOT_HEIGHT + GAP;
    }
    if (durability === 'instance' && instance) {
      y += 'entries' in instance ? ENTRY_HEIGHT * (entries.length + 1) : ENTRY_HEIGHT;
      y += 4;
    }
    groupBoxes.push({ durability, y: start, height: y - start });
    y += GROUP_GAP;
  }
  const rightBottom = groups.length ? y - GROUP_GAP : top;

  // Left column, centred against the right.
  const leftHeight = functions.length ? functions.length * (FN_HEIGHT + GAP) - GAP : 0;
  const leftTop = top + Math.max(0, (rightBottom - top - leftHeight) / 2);
  const fnPos = new Map<string, Placed>();
  functions.forEach((fn, i) =>
    fnPos.set(`fn:${fn}`, { x: fnX, y: leftTop + i * (FN_HEIGHT + GAP), width: fnWidth, height: FN_HEIGHT }),
  );

  const bodyBottom = Math.max(rightBottom, leftTop + leftHeight);
  const legend = renderLegend(LEGEND_KINDS, { idPrefix: `${prefix}legend` });
  const legendHeight = 16 + LEGEND_KINDS.length * 24;
  const legendTop = bodyBottom + 20;
  const width = Math.ceil(Math.max(contentWidth, PAD * 2 + 260));
  const height = Math.ceil(legendTop + legendHeight + PAD);

  // Focus: the node, its one-hop neighbours, the edges between them.
  const focusValid = opts.focus !== undefined && (fnPos.has(opts.focus) || slotPos.has(opts.focus));
  const neighbours = new Set<string>();
  if (focusValid) {
    for (const a of accesses) {
      if (`fn:${a.fn}` === opts.focus) neighbours.add(a.slot);
      if (a.slot === opts.focus) neighbours.add(`fn:${a.fn}`);
    }
  }
  const stateClass = (id: string) =>
    !focusValid ? '' : id === opts.focus ? ' viz-focused' : neighbours.has(id) ? ' viz-neighbour' : ' viz-dimmed';

  const desc = `${plural(slots.length, 'storage slot')} and ${plural(functions.length, 'function')}, ${plural(accesses.length, 'observed access')}. ${storageHeading(input)}`;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" role="figure" aria-labelledby="${prefix}title ${prefix}desc" class="contract-diagram storage-diagram" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${FONT_PX}">`,
  );
  parts.push(`  <title id="${prefix}title">${escapeXml(opts.title)}</title>`);
  parts.push(`  <desc id="${prefix}desc">${escapeXml(desc)}</desc>`);
  if (opts.theme) {
    parts.push(`  <style>${generateInlineTokensStyle(opts.theme === 'auto' ? undefined : opts.theme)}</style>`);
    parts.push(`  <rect class="storage-ground" width="${width}" height="${height}" fill="${cssVar('ground')}"/>`);
  }
  parts.push('  <defs>');
  for (const marker of ['open-arrow', 'filled-arrow'] as const) {
    parts.push(
      `    <marker id="${markerId(prefix, marker)}" markerWidth="8" markerHeight="8" refX="7.5" refY="3" orient="auto" markerUnits="strokeWidth">${markerGlyph(marker)}</marker>`,
    );
  }
  parts.push('  </defs>');

  headingLines.forEach((line, i) =>
    parts.push(
      `  <text class="storage-heading" x="${PAD}" y="${PAD + i * LINE + 12}" font-size="${SMALL_PX}" fill="${cssVar('muted')}">${escapeXml(line)}</text>`,
    ),
  );

  // Group frames, dashed: the grouping is observed too.
  for (const box of groupBoxes) {
    const count = slots.filter((s) => s.durability === box.durability).length;
    parts.push(
      `  <g class="storage-group" data-durability="${box.durability}"><rect x="${slotX}" y="${box.y}" width="${slotWidth}" height="${box.height}" rx="4" fill="none" stroke="${cssVar('edge')}" stroke-dasharray="${dashArray('dashed')}"/><text x="${slotX + 8}" y="${box.y + 18}" font-size="${SMALL_PX}" fill="${cssVar('muted')}">${box.durability} · ${plural(count, 'slot')}</text></g>`,
    );
  }

  // Edges, behind the nodes. Each end gets its own port, spread down the
  // node's side in the order of the other end, so no two arrowheads overlap.
  const port = (key: (a: Access) => string, order: (a: Access) => number) => {
    const at = new Map<Access, { i: number; n: number }>();
    const byNode = new Map<string, Access[]>();
    for (const a of accesses) byNode.set(key(a), [...(byNode.get(key(a)) ?? []), a]);
    for (const list of byNode.values()) {
      list.sort((p, q) => order(p) - order(q));
      list.forEach((a, i) => at.set(a, { i, n: list.length }));
    }
    return (a: Access, top: number, height: number) => {
      const { i, n } = at.get(a)!;
      return top + ((i + 1) * height) / (n + 1);
    };
  };
  const startY = port((a) => a.fn, (a) => slotPos.get(a.slot)!.y);
  const endY = port((a) => a.slot, (a) => fnPos.get(`fn:${a.fn}`)!.y);
  for (const a of accesses) {
    const from = fnPos.get(`fn:${a.fn}`)!;
    const to = slotPos.get(a.slot)!;
    const x1 = from.x + from.width;
    const y1 = startY(a, from.y, from.height);
    const x2 = to.x;
    const y2 = endY(a, to.y, to.height);
    const bend = COLUMN_GAP / 2;
    const vocab = EDGE_VOCABULARY[a.kind];
    const incident = focusValid && (`fn:${a.fn}` === opts.focus || a.slot === opts.focus);
    const edgeState = !focusValid ? '' : incident ? ' viz-edge--incident' : ' viz-dimmed';
    const verb = a.kind === 'observed-write' ? 'writes' : 'reads';
    const slotName = a.slot.split(':').slice(2).join(':');
    parts.push(
      `  <path class="diagram-edge storage-edge storage-edge--${verb}${edgeState}" data-edge-kind="${a.kind}" data-from="fn:${escapeXml(a.fn)}" data-to="${escapeXml(a.slot)}" d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}" fill="none" stroke="${cssVar(vocab.token)}" stroke-width="1.75" stroke-dasharray="${dashArray(vocab.dash)}" marker-end="url(#${markerId(prefix, vocab.marker)})"><title>${escapeXml(`${a.fn} ${verb} ${slotName} (observed)`)}</title></path>`,
    );
  }

  // Function nodes.
  for (const fn of functions) {
    const id = `fn:${fn}`;
    const p = fnPos.get(id)!;
    const href = opts.hrefForFunction?.(fn) ?? null;
    const open = href
      ? `<a href="${escapeXml(href)}" data-node-id="${escapeXml(id)}" class="storage-node${stateClass(id)}">`
      : `<g data-node-id="${escapeXml(id)}" class="storage-node${stateClass(id)}">`;
    parts.push(
      `  ${open}<title>${escapeXml(fn)}</title>${nodeShapeSvg('rounded-rect', p.x, p.y, p.width, p.height)}<text x="${p.x + 12}" y="${p.y + p.height / 2}" dominant-baseline="central" fill="${cssVar('nodeText')}">${escapeXml(truncateLabel(fn, MAX_FN_CELLS))}</text>${href ? '</a>' : '</g>'}`,
    );
  }

  // Slot nodes: shape, distinct keys, and the spec type it matched.
  for (const slot of slots) {
    const id = slotId(slot);
    const p = slotPos.get(id)!;
    const typeHref = slot.specType ? (opts.hrefForType?.(slot.specType) ?? null) : null;
    const meta = slotMeta(slot);
    const typeX = p.x + 12 + textWidth(meta, SMALL_PX);
    const typeText = slot.specType
      ? typeHref
        ? `<a href="${escapeXml(typeHref)}" class="storage-type-link"><text x="${typeX}" y="${p.y + 33}" font-size="${SMALL_PX}" fill="${cssVar('accent')}" text-decoration="underline">${escapeXml(slot.specType)}</text></a>`
        : `<text x="${typeX}" y="${p.y + 33}" font-size="${SMALL_PX}" fill="${cssVar('muted')}">${escapeXml(slot.specType)}</text>`
      : '';
    parts.push(
      `  <g id="${prefix}${escapeXml(id.replace(/[^A-Za-z0-9_-]/g, '-'))}" data-node-id="${escapeXml(id)}" data-durability="${slot.durability}" data-distinct-keys="${slot.distinctKeys}" class="storage-node storage-slot${stateClass(id)}"><title>${escapeXml(slotTitle(slot))}</title>${nodeShapeSvg('rect', p.x, p.y, p.width, p.height, { stroke: 'observed' })}<text x="${p.x + 12}" y="${p.y + 16}" fill="${cssVar('nodeText')}">${escapeXml(slotLabel(slot))}</text><text x="${p.x + 12}" y="${p.y + 33}" font-size="${SMALL_PX}" fill="${cssVar('muted')}">${escapeXml(meta)}</text>${typeText}</g>`,
    );
  }

  // The instance entry's keys, at the ledger read.
  const instanceBox = groupBoxes.find((b) => b.durability === 'instance');
  if (instance && instanceBox) {
    let ey = instanceBox.y + instanceBox.height - 4 - (('entries' in instance ? entries.length + 1 : 1) * ENTRY_HEIGHT);
    const rows: string[] = [];
    if ('entries' in instance) {
      rows.push(
        `<text x="${slotX + 8}" y="${ey + 14}" font-size="${SMALL_PX}" fill="${cssVar('muted')}">instance entry at ledger ${instance.ledger}: ${plural(entries.length, 'key')}</text>`,
      );
      ey += ENTRY_HEIGHT;
      for (const e of entries) {
        rows.push(
          `<text data-instance-key="${escapeXml(e.shape)}" x="${slotX + 16}" y="${ey + 14}" font-size="${SMALL_PX}" fill="${cssVar('nodeText')}"><title>${escapeXml(`${e.key}: ${e.valueType} ${e.valuePreview}`)}</title>${escapeXml(entryText(e))}</text>`,
        );
        ey += ENTRY_HEIGHT;
      }
    } else {
      rows.push(
        `<text x="${slotX + 8}" y="${ey + 14}" font-size="${SMALL_PX}" fill="${cssVar('muted')}"><title>${escapeXml(instance.reason)}</title>${escapeXml(truncateLabel(instance.reason, 80))}</text>`,
      );
    }
    parts.push(`  <g class="storage-instance">${rows.join('')}</g>`);
  }

  parts.push(`  <g transform="translate(${PAD}, ${legendTop})">${legend}</g>`);
  parts.push('</svg>');
  return parts.join('\n');
}

/**
 * The storage view as text, for the "Diagram as text" outline: the heading,
 * then each durability's slots with who read and wrote them, then the
 * instance entry's keys.
 */
export function renderStorageOutlineHtml(
  input: StorageViewInput,
  hrefForType: (name: string) => string | null = () => null,
): string {
  const out: string[] = ['<section class="storage-outline">', '<h3>Storage (observed)</h3>'];
  out.push(`<p>${escapeXml(storageHeading(input))}</p>`, '<ul>');
  const instance = input.instance ?? null;
  for (const durability of DURABILITY_ORDER) {
    const slots = input.slots.filter((s) => s.durability === durability);
    if (!slots.length && !(durability === 'instance' && instance)) continue;
    out.push(`<li>${durability}<ul>`);
    for (const slot of slots) {
      const href = slot.specType ? hrefForType(slot.specType) : null;
      const type = slot.specType
        ? ` Key type: ${href ? `<a href="${escapeXml(href)}">${escapeXml(slot.specType)}</a>` : escapeXml(slot.specType)}.`
        : '';
      out.push(`<li id="outline-${escapeXml(slotId(slot).replace(/[^A-Za-z0-9_-]/g, '-'))}"><code>${escapeXml(slot.shape)}</code>: ${escapeXml(slotFacts(slot, false))}${type}</li>`);
    }
    if (durability === 'instance' && instance) {
      if ('entries' in instance) {
        out.push(`<li>Instance entry at ledger ${instance.ledger}<ul>`);
        for (const e of instance.entries) {
          out.push(`<li><code>${escapeXml(e.shape)}</code> = ${escapeXml(e.valuePreview)} (${escapeXml(e.valueType)})</li>`);
        }
        out.push('</ul></li>');
      } else {
        out.push(`<li>${escapeXml(instance.reason)}</li>`);
      }
    }
    out.push('</ul></li>');
  }
  out.push('</ul>', '</section>');
  return out.join('');
}
