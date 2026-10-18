/**
 * @file apps/web/lib/contract-upgrades.ts
 *
 * Pure presentation model for contract WASM upgrade history (#454, backlog C-12).
 *
 * Epic A owns upgrade history: the `ContractWasmVersion` model (#414) gets its
 * first row when the deployment worker records a contract (#415) and a new row
 * whenever the executable-refresh worker sees the hash move (#416).
 *
 * This module transforms `ContractWasmVersion` rows into a structured display
 * model: newest first, earliest labelled "first seen by the indexer", later rows
 * "change observed by the indexer", with header notes and the detection window sentence.
 *
 * Pure: no network, no database, no clock.
 */

import { formatDate } from './format-date.ts';
import { truncateMiddle } from './contract-header.ts';

/** Input shape matching a ContractWasmVersion database record or fixture row. */
export interface WasmVersionRow {
  readonly wasmHash: string;
  readonly observedAt: Date | string;
  readonly observedLedger: number;
}

/** One item in the upgrade history list, presented newest first. */
export interface UpgradeItem {
  readonly wasmHash: string;
  readonly truncatedHash: string;
  readonly observedAt: string;
  readonly observedOn: string;
  readonly observedLedger: number;
  readonly label: 'first seen by the indexer' | 'change observed by the indexer';
}

/** The described upgrade history for a contract. */
export interface UpgradesDescription {
  /** True when the contract has at least one recorded upgrade (more than 1 row). */
  readonly hasUpgrades: boolean;
  /** Number of upgrades observed (rows.length - 1 when > 0, otherwise 0). */
  readonly upgradeCount: number;
  /** All recorded versions ordered newest first. */
  readonly versions: readonly UpgradeItem[];
  /** Header note, e.g. "upgraded 1 time since 1 Mar 2026", null when <= 1 row. */
  readonly headerNote: string | null;
  /** Window sentence stating indexer limits, null when 0 rows. */
  readonly windowSentence: string | null;
  /** Alias for windowSentence. */
  readonly windowNote: string | null;
}

function counted(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Describes WASM version rows for presentation on the contract page.
 *
 * - Orders versions newest first.
 * - Labels the oldest row "first seen by the indexer" and later rows "change observed by the indexer".
 * - Forms the header note "upgraded {n} times since {date}" when there is more than one row.
 * - Forms the window sentence stating when tracking began.
 */
export function describeUpgrades(rows: readonly WasmVersionRow[]): UpgradesDescription {
  if (!rows || rows.length === 0) {
    return {
      hasUpgrades: false,
      upgradeCount: 0,
      versions: [],
      headerNote: null,
      windowSentence: null,
      windowNote: null,
    };
  }

  // Sort chronologically (oldest first)
  const chronological = [...rows].sort((a, b) => {
    const tA = new Date(a.observedAt).getTime();
    const tB = new Date(b.observedAt).getTime();
    if (tA !== tB) return tA - tB;
    return a.observedLedger - b.observedLedger;
  });

  const oldest = chronological[0]!;
  const oldestIso =
    oldest.observedAt instanceof Date ? oldest.observedAt.toISOString() : String(oldest.observedAt);
  const oldestDate = formatDate(oldestIso);

  const windowSentence = `Changes before ${oldestDate} are not recorded. Dates are when Signet's indexer noticed each hash, not when the upgrade transaction ran.`;

  const upgradeCount = Math.max(0, rows.length - 1);
  const headerNote =
    rows.length > 1 ? `upgraded ${counted(upgradeCount, 'time', 'times')} since ${oldestDate}` : null;

  // Output list is ordered newest first
  const newestFirst = [...chronological].reverse();
  const versions: UpgradeItem[] = newestFirst.map((row) => {
    const isOldest = row === oldest;
    const iso =
      row.observedAt instanceof Date ? row.observedAt.toISOString() : String(row.observedAt);
    return {
      wasmHash: row.wasmHash,
      truncatedHash: truncateMiddle(row.wasmHash, 8, 8),
      observedAt: iso,
      observedOn: formatDate(iso),
      observedLedger: row.observedLedger,
      label: isOldest ? 'first seen by the indexer' : 'change observed by the indexer',
    };
  });

  return {
    hasUpgrades: rows.length > 1,
    upgradeCount,
    versions,
    headerNote,
    windowSentence,
    windowNote: windowSentence,
  };
}
