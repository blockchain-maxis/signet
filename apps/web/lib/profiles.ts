import { promises as fs } from 'fs';
import path from 'path';

/**
 * Single source of truth for profile data.
 *
 * Reads the curated static manifest in `public/data/`. This is what powers the
 * canonical `/p/{handle}` profile route. It has no database dependency, so it
 * works in every environment (preview, prod, offline) without provisioning.
 *
 * When the indexer + Postgres come online (Phase 2), `getProfile` can try the
 * database first and fall back to the static manifest — see `safeDbProfile`.
 */

export type Profile = {
  name: string;
  wallet: string;
  bio: string;
  joined: string;
};

export type Operation = {
  id: string;
  type: string;
  function?: string;
  decoded_function?: string;
  source_account?: string;
  created_at: string;
  transaction_hash?: string;
  transaction_successful?: boolean;
  asset_balance_changes?: Array<{
    asset_type: string;
    asset_code?: string;
    type: string;
    from?: string;
    to?: string;
    amount?: string;
  }>;
};

const DATA_DIR = path.join(process.cwd(), 'public/data');

/** A handle is 1–32 chars of `[a-z0-9_-]` — mirrors the on-chain registry. */
const HANDLE_RE = /^[a-z0-9_-]{1,32}$/;

export function isValidHandle(handle: string): boolean {
  return HANDLE_RE.test(handle);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, file), 'utf-8')) as T;
  } catch {
    return null;
  }
}

export async function getProfile(handle: string): Promise<Profile | null> {
  if (!isValidHandle(handle)) return null;
  // Prefer the database (on-chain-synced bindings) when one is configured;
  // otherwise fall back to the curated static manifest. `safeDbProfile`
  // returns null whenever there's no DB, so this is a no-op until provisioned.
  const fromDb = await safeDbProfile(handle);
  if (fromDb) return fromDb;
  const manifest = await readJson<Record<string, Profile>>('profiles.json');
  return manifest?.[handle] ?? null;
}

export async function getOperations(handle: string): Promise<Operation[]> {
  if (!isValidHandle(handle)) return [];
  // Prefer indexer-populated DB rows; fall back to the static demo JSON.
  const fromDb = await safeDbOperations(handle);
  if (fromDb && fromDb.length > 0) return fromDb;
  const data = await readJson<{ _embedded?: { records?: Operation[] } }>(`${handle}.json`);
  return data?._embedded?.records ?? [];
}

export interface ProfileStats {
  invocations: number;
  uniqueFunctions: number;
  /** 0–100 heuristic reputation score from observed activity. */
  reputation: number;
}

function functionOf(op: Operation): string {
  return op.decoded_function ?? op.function ?? 'invoke_contract';
}

/**
 * Compute display stats + a transparent reputation score from operations.
 * The score is a simple, explainable heuristic (not gameable signal yet):
 * volume of successful invocations + diversity of functions exercised.
 */
export function computeStats(operations: Operation[] | null | undefined): ProfileStats {
  const source = Array.isArray(operations) ? operations : [];
  const successful = source.filter((op) => op.transaction_successful !== false);
  const uniqueFunctions = new Set(successful.map(functionOf)).size;
  const invocations = successful.length;
  // 6 pts per invocation (cap 60) + 10 pts per distinct function (cap 40).
  const reputation = Math.min(100, Math.min(60, invocations * 6) + Math.min(40, uniqueFunctions * 10));
  return { invocations, uniqueFunctions, reputation };
}

export async function listHandles(): Promise<string[]> {
  const manifest = await readJson<Record<string, Profile>>('profiles.json');
  return manifest ? Object.keys(manifest) : [];
}

/**
 * Best-effort database lookup. Returns null on ANY failure — no `DATABASE_URL`,
 * unreachable DB, empty result — so callers degrade gracefully to static data
 * instead of throwing a 500. The DB client is imported lazily so the web app
 * never hard-depends on Postgres being present.
 */
export async function safeDbProfile(handle: string): Promise<Profile | null> {
  if (!process.env.DATABASE_URL || !isValidHandle(handle)) return null;
  try {
    const { prisma } = await import('@signet/db');
    const row = await prisma.profile.findUnique({
      where: { handle: handle.toLowerCase() },
      include: { wallets: { where: { isPrimary: true }, take: 1 } },
    });
    if (!row) return null;
    return {
      name: row.displayName ?? row.handle,
      wallet: row.wallets[0]?.pubkey ?? '',
      bio: row.bio ?? '',
      joined: row.createdAt.toISOString().slice(0, 10),
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort lookup of indexer-populated operations for a handle. Returns null
 * on any failure (no DB, unreachable, error) so `getOperations` falls back to
 * the static JSON. Maps DB rows to the Horizon-shaped `Operation` the UI uses.
 */
export async function safeDbOperations(handle: string): Promise<Operation[] | null> {
  if (!process.env.DATABASE_URL || !isValidHandle(handle)) return null;
  try {
    const { prisma } = await import('@signet/db');
    const profile = await prisma.profile.findUnique({
      where: { handle: handle.toLowerCase() },
      include: {
        wallets: {
          include: { operations: { orderBy: { createdAt: 'desc' }, take: 100 } },
        },
      },
    });
    if (!profile) return null;
    return profile.wallets
      .flatMap((w) => w.operations)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((op) => ({
        id: op.id,
        type: op.type,
        function: op.function ?? undefined,
        decoded_function: op.decodedFunction ?? undefined,
        source_account: op.sourceAccount ?? undefined,
        created_at: op.createdAt.toISOString(),
        transaction_hash: op.transactionHash ?? undefined,
        transaction_successful: op.successful,
        asset_balance_changes:
          (op.balanceChanges as unknown as Operation['asset_balance_changes']) ?? undefined,
      }));
  } catch {
    return null;
  }
}
