/**
 * @file Activity overlay data (#518): when a contract has been used, and
 * which functions get used, from its indexed invocations.
 *
 * The indexer's snapshots cannot answer this (their Horizon counts are zero
 * for a `C…` address, and they are pruned), so the counts come from the
 * stored `ContractInvocation` rows: a series of per-hour or per-day buckets
 * for the sparkline, and a count per function for the heat bars and
 * `rankByFrequency`. What the stored rows cannot see is said, not hidden:
 * a range that starts before the oldest stored call says how much of it is
 * covered.
 *
 * Pure: times in, plain data and SVG strings out, UTC throughout, colours
 * only from the `--viz-*` tokens.
 */

import { VIZ_CSS_VARIABLES, type VizTokenName } from './tokens.ts';

export type ActivityRange = '24h' | '7d' | '30d';
export const ACTIVITY_RANGES: readonly ActivityRange[] = ['24h', '7d', '30d'];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** One stored invocation, as much as the overlay needs. */
export interface ActivityCall {
  readonly function: string | null;
  readonly createdAt: Date | number;
}

export interface ActivityBucket {
  /** Start of the bucket, ms since the epoch (UTC). */
  readonly start: number;
  readonly count: number;
}

export interface ActivitySeries {
  readonly range: ActivityRange;
  /** Hourly for 24h, daily for 7d and 30d; oldest first. */
  readonly buckets: readonly ActivityBucket[];
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly total: number;
  readonly peak: ActivityBucket | null;
  /** The newest stored call, in or before the range. */
  readonly lastActivity: number | null;
  /** The oldest stored call: before it, nothing was counted. */
  readonly oldestStored: number | null;
  /** From the snapshot (#429): the oldest call the counts cover, and whether the cap was hit. */
  readonly countedSince: number | null;
  readonly totalIsFloor: boolean;
}

export interface ActivityOverlay {
  readonly series: ActivitySeries;
  /** Calls in the range, by function name. */
  readonly counts: Readonly<Record<string, number>>;
}

function at(t: Date | number): number {
  return typeof t === 'number' ? t : t.getTime();
}

/** The range's bucket size and count, ending at the bucket holding `now`. */
function bucketsFor(range: ActivityRange, now: number): { size: number; n: number; first: number } {
  const size = range === '24h' ? HOUR : DAY;
  const n = range === '24h' ? 24 : range === '7d' ? 7 : 30;
  const last = Math.floor(now / size) * size;
  return { size, n, first: last - (n - 1) * size };
}

/**
 * Aggregates stored calls into the range's buckets and per-function counts.
 * `oldestStored`, `lastActivity`, `countedSince` and `totalIsFloor` come
 * from the caller, since the calls passed in are only those in the range.
 */
export function aggregateActivity(
  calls: readonly ActivityCall[],
  range: ActivityRange,
  now: Date | number,
  known: {
    oldestStored?: Date | number | null;
    lastActivity?: Date | number | null;
    countedSince?: Date | number | null;
    totalIsFloor?: boolean;
  } = {},
): ActivityOverlay {
  const { size, n, first } = bucketsFor(range, at(now));
  const counts = new Array<number>(n).fill(0);
  const byFunction: Record<string, number> = {};
  let newest: number | null = null;
  for (const call of calls) {
    const t = at(call.createdAt);
    const i = Math.floor((t - first) / size);
    if (i < 0 || i >= n) continue;
    counts[i]! += 1;
    if (call.function) byFunction[call.function] = (byFunction[call.function] ?? 0) + 1;
    newest = newest === null ? t : Math.max(newest, t);
  }
  const buckets = counts.map((count, i) => ({ start: first + i * size, count }));
  const total = counts.reduce((a, b) => a + b, 0);
  const peak = total === 0 ? null : buckets.reduce((best, b) => (b.count > best.count ? b : best));
  const known_ = (v: Date | number | null | undefined) => (v === null || v === undefined ? null : at(v));
  const last = known_(known.lastActivity);
  return {
    series: {
      range,
      buckets,
      rangeStart: first,
      rangeEnd: first + n * size,
      total,
      peak,
      lastActivity: last ?? newest,
      oldestStored: known_(known.oldestStored),
      countedSince: known_(known.countedSince),
      totalIsFloor: known.totalIsFloor ?? false,
    },
    counts: byFunction,
  };
}

/** `2026-10-25` for a day bucket, `2026-10-25 14:00 UTC` for an hour. */
export function formatBucket(start: number, range: ActivityRange): string {
  const iso = new Date(start).toISOString();
  return range === '24h' ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso.slice(0, 10);
}

const RANGE_WORDS: Record<ActivityRange, string> = {
  '24h': 'the last 24 hours',
  '7d': 'the last 7 days',
  '30d': 'the last 30 days',
};

/** The sparkline's summary: "412 transactions in the last 7 days, peak on 2026-10-21 (88)." */
export function describeActivity(series: ActivitySeries): string {
  if (series.lastActivity === null && series.oldestStored === null) return 'No activity recorded yet.';
  if (series.total === 0) return `No transactions in ${RANGE_WORDS[series.range]}.`;
  const total = `${series.total}${series.totalIsFloor ? '+' : ''} transaction${series.total === 1 ? '' : 's'}`;
  const peak = series.peak
    ? `, peak ${series.range === '24h' ? 'at' : 'on'} ${formatBucket(series.peak.start, series.range)} (${series.peak.count})`
    : '';
  return `${total} in ${RANGE_WORDS[series.range]}${peak}.`;
}

/**
 * What the range covers when it starts before counting did: "Counted only
 * since 2026-10-20: 5 of the 7 days." Null when the range is fully covered.
 */
export function coverageNote(series: ActivitySeries): string | null {
  const since = Math.max(series.oldestStored ?? -Infinity, series.countedSince ?? -Infinity);
  if (!Number.isFinite(since) || since <= series.rangeStart) return null;
  const unit = series.range === '24h' ? HOUR : DAY;
  const covered = Math.max(0, Math.ceil((series.rangeEnd - since) / unit));
  const of = series.buckets.length;
  const word = series.range === '24h' ? 'hours' : 'days';
  const when = series.range === '24h' ? formatBucket(since, '24h') : new Date(since).toISOString().slice(0, 10);
  return `Counted only since ${when}: ${Math.min(covered, of)} of the ${of} ${word}.`;
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

export interface SparklineOptions {
  readonly idPrefix: string;
  readonly width?: number;
  readonly height?: number;
}

/**
 * The contract-level sparkline: one line over the range's buckets, a dot
 * on the peak, and the summary as its accessible name. No animation.
 */
export function renderActivitySparkline(series: ActivitySeries, opts: SparklineOptions): string {
  const width = opts.width ?? 320;
  const height = opts.height ?? 48;
  const pad = 4;
  const max = Math.max(1, ...series.buckets.map((b) => b.count));
  const step = series.buckets.length > 1 ? (width - 2 * pad) / (series.buckets.length - 1) : 0;
  const xOf = (i: number) => Math.round((pad + i * step) * 10) / 10;
  const yOf = (count: number) => Math.round((height - pad - (count / max) * (height - 2 * pad)) * 10) / 10;
  const points = series.buckets.map((b, i) => `${xOf(i)},${yOf(b.count)}`).join(' ');
  const summary = describeActivity(series);
  const peakIndex = series.peak ? series.buckets.indexOf(series.peak) : -1;
  const peakDot =
    peakIndex >= 0
      ? `<circle class="activity-peak" cx="${xOf(peakIndex)}" cy="${yOf(series.peak!.count)}" r="2.5" fill="${cssVar('accent')}"/>`
      : '';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" class="activity-sparkline" role="img" aria-labelledby="${opts.idPrefix}spark-title" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-range="${series.range}">`,
    `<title id="${opts.idPrefix}spark-title">${escapeXml(summary)}</title>`,
    `<line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="${cssVar('edge')}" stroke-width="1"/>`,
    `<polyline points="${points}" fill="none" stroke="${cssVar('accent')}" stroke-width="1.5" stroke-linejoin="round"/>`,
    peakDot,
    '</svg>',
  ].join('');
}
