/**
 * @file Postgres-backed `SpecCache` (§4.2).
 *
 * `@signet/spec` defines the `SpecCache` contract but must stay browser-safe,
 * so it cannot import Prisma. This module is the Postgres implementation of
 * that contract — the same split as `pairing.ts` / `cli-unlink.ts`, which own
 * their Prisma slices next to the code that uses them.
 *
 * The row is keyed by `wasmHash` alone (§4.1: hash, not address — one spec
 * serves every contract deploying that WASM) and carries two pieces of
 * provenance alongside the serialised spec:
 *
 * - `sdkVersion` — the `@stellar/stellar-sdk` that decoded the entries. A row
 *   extracted by an older SDK may be missing an arm that SDK did not know, so
 *   on an SDK upgrade those rows are found via this column, reported stale by
 *   `isStale`, re-extracted and overwritten — never served.
 * - `schemaVersion` — the shape of the stored JSON (`SpecJson.schemaVersion`,
 *   #434). Below the current shape means the payload must be re-serialised
 *   from the XDR rather than read.
 *
 * Staleness is policy, not storage: `get` deliberately returns stale rows as
 * they are so a caller can tell "miss" from "stale" (for logging and for
 * deciding when to re-extract). The serving path checks `isStale` before it
 * uses a row.
 *
 * Every call fails soft when no database is configured, matching the rest of
 * `lib/server`: no `DATABASE_URL` means a miss and a no-op write, never a
 * thrown error, so pages degrade instead of 500-ing.
 */

import type { SpecCache } from '@signet/spec';

/**
 * Current shape of the stored `specJson` (`SpecJson.schemaVersion`, #434).
 * Bumped when the serialised payload changes in a way older readers cannot
 * interpret; a row below this version is stale regardless of which SDK wrote
 * it. (Additive `SpecJson` fields keep v1 — see the bump policy in #434.)
 */
export const SPEC_SCHEMA_VERSION = 1;

/**
 * Version of the installed `@stellar/stellar-sdk` this server runs.
 *
 * The package exports no version symbol and its `package.json` is not in its
 * `exports` map, so the version cannot be read at runtime — it is a literal
 * that a dependency bump must update. `spec-store.test.ts` resolves the
 * installed package and fails if it disagrees with this constant, so drift
 * breaks CI instead of silently serving stale rows.
 */
export const RUNNING_SDK_VERSION = '16.1.0';

/**
 * Compare two dotted SDK versions numerically, semver-style.
 *
 * Segment-by-segment numeric comparison (`"16.1.0"` < `"16.10.0"`, missing
 * segments count as `0`). A `-suffix` marks a prerelease: for an otherwise
 * equal version the prerelease sorts *before* the release (`"16.1.0-rc.1"` <
 * `"16.1.0"`), which is what makes a row extracted by an RC report stale once
 * the final SDK is installed. Two prereleases of the same base compare equal —
 * their relative order is not a decision this store needs to make.
 *
 * @param a - left-hand version string.
 * @param b - right-hand version string.
 * @returns negative when `a` is older, positive when newer, `0` when equal.
 */
export function compareSdkVersions(a: string, b: string): number {
  const [aCore = '', aPre] = a.split('-');
  const [bCore = '', bPre] = b.split('-');
  const aParts = aCore.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const bParts = bCore.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < length; i += 1) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }

  if (aPre === undefined && bPre !== undefined) return 1; // release > prerelease
  if (aPre !== undefined && bPre === undefined) return -1; // prerelease < release
  return 0;
}

/**
 * The serialised spec plus its provenance — what `set` writes.
 *
 * Structural stand-in for `SpecJson` (#434), which does not exist yet: the
 * store only persists what it is handed and never interprets `specJson`.
 */
export interface StoredSpec {
  /** Shape version of `specJson` (`SpecJson.schemaVersion`, #434). */
  readonly schemaVersion: number;
  /** `@stellar/stellar-sdk` version that decoded the entries. */
  readonly sdkVersion: string;
  /** Serialised spec (`SpecJson`, #434). */
  readonly specJson: unknown;
}

/** A stored row as `get` returns it: the payload plus its key and timestamp. */
export interface StoredSpecRow extends StoredSpec {
  /** Lowercase 64-character hex SHA-256 of the WASM. */
  readonly wasmHash: string;
  /** When the entries were last extracted (and written). */
  readonly extractedAt: Date;
}

/** The slice of Prisma this module touches, so tests can inject a fake. */
export interface SpecStore {
  contractSpec: {
    findUnique(args: { where: { wasmHash: string } }): Promise<StoredSpecRow | null>;
    upsert(args: {
      where: { wasmHash: string };
      create: {
        wasmHash: string;
        schemaVersion: number;
        sdkVersion: string;
        specJson: unknown;
        extractedAt: Date;
      };
      update: {
        schemaVersion: number;
        sdkVersion: string;
        specJson: unknown;
        extractedAt: Date;
      };
    }): Promise<unknown>;
  };
}

/**
 * True when a stored row must not be served: its SDK is older than the one
 * running now, or its `specJson` shape is older than `SPEC_SCHEMA_VERSION`.
 * Such a row is re-extracted and overwritten (§4.2), never handed to a
 * renderer.
 *
 * @param row - stored row (or any `{ sdkVersion, schemaVersion }` shape).
 * @returns `true` when the row needs re-extraction.
 */
export function isStale(row: Pick<StoredSpec, 'sdkVersion' | 'schemaVersion'>): boolean {
  if (row.schemaVersion < SPEC_SCHEMA_VERSION) return true;
  return compareSdkVersions(row.sdkVersion, RUNNING_SDK_VERSION) < 0;
}

/**
 * `SpecCache` over the `ContractSpec` table.
 *
 * `get` resolves the Prisma client per call rather than at module load (the
 * same reason `registry-read.ts` resolves config per call): Next.js server
 * components and the test runner both set `process.env` after this module is
 * first imported, and a frozen `DATABASE_URL` check there would be a silently
 * unconfigured store. The returned row carries `wasmHash` and `extractedAt`
 * on top of the `StoredSpec` payload the interface guarantees.
 */
export class PrismaSpecCache implements SpecCache<StoredSpec> {
  private readonly injected?: SpecStore;

  constructor(store?: SpecStore) {
    this.injected = store;
  }

  private async db(): Promise<SpecStore | null> {
    if (this.injected) return this.injected;
    if (!process.env.DATABASE_URL) return null;
    const { prisma } = await import('@signet/db');
    return prisma as unknown as SpecStore;
  }

  /** Stored row for `wasmHash`, or `undefined` on a miss (or no database). */
  async get(wasmHash: string): Promise<StoredSpecRow | undefined> {
    const db = await this.db();
    if (!db) return undefined;
    const row = await db.contractSpec.findUnique({ where: { wasmHash } });
    return row ?? undefined;
  }

  /**
   * Insert or replace the row for `wasmHash`, stamping `extractedAt` with
   * now — an overwrite is how a stale row is retired (§4.2), so the previous
   * payload is replaced unconditionally. No database: silent no-op.
   */
  async set(wasmHash: string, spec: StoredSpec): Promise<void> {
    const db = await this.db();
    if (!db) return;
    const data = {
      schemaVersion: spec.schemaVersion,
      sdkVersion: spec.sdkVersion,
      specJson: spec.specJson,
      extractedAt: new Date(),
    };
    await db.contractSpec.upsert({
      where: { wasmHash },
      create: { wasmHash, ...data },
      update: data,
    });
  }
}
