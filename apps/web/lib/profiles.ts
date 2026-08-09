import { promises as fs } from 'fs';
import path from 'path';
import { DEMO_PROFILES, isValidHandle } from '@signet/types';
import {
  ALLOW_HTTP,
  NETWORK_PASSPHRASE,
  REGISTRY_CONTRACT_ID,
  SOROBAN_RPC_URL,
  isRegistryConfigured,
} from './chain.ts';

/**
 * Single source of truth for profile data.
 *
 * `getProfile` resolves a handle through three layers, in order:
 *
 *   1. database — indexer-synced bindings, when a `DATABASE_URL` is configured
 *   2. chain    — a live `resolve(handle)` read against the Identity Registry
 *                 over Soroban RPC, when the contract is deployed
 *   3. static   — the curated demo personas, `DEMO_PROFILES` from
 *                 `@signet/types`. That is the one shared source the indexer
 *                 seed (`apps/indexer/src/seed-data.ts`) also derives from, so
 *                 demo addresses live in exactly one place.
 *
 * The chain layer is what lets a handle claimed on-chain render at
 * `/p/{handle}` before (or without) the indexer syncing it into Postgres —
 * previously such a handle 404'd. Each layer degrades to the next rather than
 * throwing: no database, no deployed registry, or an unreachable RPC all fall
 * through, so the curated demo profiles keep working in every environment
 * (preview, prod, offline) with nothing provisioned at all.
 */

/**
 * Which of the three layers answered a lookup. Carried on the profile so the
 * UI can label provenance honestly: a handle bound on-chain must not be
 * presented with the curated manifest's "synthetic demo data" framing, and
 * curated data must never be presented as a real binding.
 */
export type ProfileSource = 'database' | 'chain' | 'demo';

export type Profile = {
  name: string;
  wallet: string;
  bio: string;
  joined: string;
  source: ProfileSource;
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

/**
 * The curated demo manifest, keyed by handle, built from the shared source in
 * `@signet/types` so the indexer seed and the web app can never drift apart.
 */
const DEMO_MANIFEST: Record<string, Profile> = Object.fromEntries(
  DEMO_PROFILES.map((p) => [
    p.handle,
    { name: p.name, wallet: p.wallet, bio: p.bio, joined: p.joined, source: 'demo' as const },
  ]),
);

// Handle rules live in @signet/types, mirrored from the on-chain registry.
// Re-exported here so existing callers keep importing it from this module.
export { isValidHandle };

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, file), 'utf-8')) as T;
  } catch {
    return null;
  }
}

export async function getProfile(handle: string): Promise<Profile | null> {
  if (!isValidHandle(handle)) return null;
  // Prefer the database (indexer-synced bindings, plus the off-chain display
  // fields the other layers can't supply) when one is configured.
  // `safeDbProfile` returns null whenever there's no DB, so this is a no-op
  // until provisioned.
  const fromDb = await safeDbProfile(handle);
  if (fromDb) return fromDb;
  // A handle can be bound on-chain long before the indexer syncs it into the
  // database — or with no database at all. Ask the registry directly so it
  // renders instead of 404ing.
  const fromChain = await safeChainProfile(handle);
  if (fromChain) return fromChain;
  return DEMO_MANIFEST[handle] ?? null;
}

export async function getOperations(handle: string): Promise<Operation[]> {
  if (!isValidHandle(handle)) return [];

  // 1. Prefer indexer-populated DB rows (fastest, richest data including decoded_function).
  const fromDb = await safeDbOperations(handle);
  if (fromDb && fromDb.length > 0) return fromDb;

  // 2. Horizon fallback: fetch invoke_host_function ops for the bound wallet directly
  //    from the Horizon API. This makes claimed handles work without a database.
  //    We need the profile to resolve the wallet address, but only if the DB didn't
  //    already return an empty array because the profile genuinely has no ops yet.
  if (fromDb === null) {
    // DB is unavailable (no DATABASE_URL or connection failed) — try Horizon.
    const profile = await getProfile(handle);
    if (profile?.wallet) {
      const { fetchHorizonOperations } = await import('./server/horizon.ts');
      const fromHorizon = await fetchHorizonOperations(profile.wallet);
      if (fromHorizon && fromHorizon.length > 0) return fromHorizon;
    }
  }

  // 3. Static demo JSON (for the curated demo handles: aquawolf, sorobuilder, stellardev).
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
  return Object.keys(DEMO_MANIFEST);
}

/**
 * Best-effort list of every handle bound in the database — curated-synced rows
 * plus self-sovereign on-chain attestations. Returns `[]` on any failure (no
 * `DATABASE_URL`, unreachable DB) so callers still build from the static
 * manifest alone. The DB client is imported lazily, like `safeDbProfile`.
 */
export async function safeDbHandles(): Promise<string[]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    const { prisma } = await import('@signet/db');
    const rows = await prisma.profile.findMany({ select: { handle: true } });
    return rows.map((r) => r.handle);
  } catch {
    return [];
  }
}

/**
 * Best-effort list of every handle currently bound on the Identity Registry,
 * read live from the chain. This is what makes the sitemap correct before —
 * or entirely without — an indexer sync: a handle claimed on-chain is listed
 * as soon as the binding exists. Returns `[]` when no registry is configured
 * or the RPC is unreachable, and imports `lib/directory` lazily to keep the
 * module graph acyclic (`directory` imports back from here).
 */
export async function safeChainHandles(): Promise<string[]> {
  if (!isRegistryConfigured()) return [];
  try {
    const { fetchLiveDirectory } = await import('./directory.ts');
    const entries = await fetchLiveDirectory();
    return entries?.map((e) => e.handle) ?? [];
  } catch {
    return [];
  }
}

/**
 * Every public handle for surfaces like the sitemap and OG images: the curated
 * manifest unioned with the database and with live on-chain bindings,
 * de-duplicated. Mirrors `getProfile`'s three layers, so anything that renders
 * at `/p/{handle}` is also listed. Each source degrades to `[]` on its own, so
 * with nothing provisioned this is just the manifest.
 */
export async function listAllHandles(): Promise<string[]> {
  const [curated, fromDb, fromChain] = await Promise.all([
    listHandles(),
    safeDbHandles(),
    safeChainHandles(),
  ]);
  return [...new Set([...curated, ...fromDb, ...fromChain])];
}

/**
 * Best-effort database lookup. Returns null on ANY failure — no `DATABASE_URL`,
 * unreachable DB, empty result — so callers degrade gracefully to the chain
 * and static layers instead of throwing a 500. The DB client is imported
 * lazily so the web app
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
      source: 'database',
    };
  } catch {
    return null;
  }
}

/**
 * A Stellar `Address`: either a `G…` account or a `C…` contract StrKey. The
 * registry binds a handle to an `Address`, so a contract-controlled identity
 * (a multisig or an account abstraction wallet) is just as valid as a
 * classic account and must not be dropped here.
 */
const ADDRESS_RE = /^[GC][A-Z2-7]{55}$/;

/**
 * Decode the return value of `resolve(handle) -> Option<Address>` into an
 * address string, or null when the handle is unbound (`None` decodes to null)
 * or the response isn't the shape we expect. Pure and exported so the decode
 * can be tested without touching the network.
 */
export function decodeResolvedAddress(value: unknown): string | null {
  return typeof value === 'string' && ADDRESS_RE.test(value) ? value : null;
}

/**
 * Source account for read-only simulation. Simulating a view call never reads
 * the source account's balance or sequence, so the well-known null account is
 * used rather than a funded one — a lookup must not require an account to
 * exist, and reusing a constant avoids generating a throwaway keypair per
 * request.
 */
const SIMULATION_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/**
 * Best-effort on-chain resolution of a handle to a profile. Reads the Identity
 * Registry's `resolve(handle) -> Option<Address>` view through a read-only
 * Soroban RPC simulation — no signature, no fee, nothing submitted — and, when
 * the handle is bound, returns a minimal profile built from that binding.
 *
 * Returns null on ANY miss: registry not deployed, handle unbound, RPC
 * unreachable, malformed response. `getProfile` then falls through to the
 * static manifest rather than throwing a 500. The stellar-sdk is imported
 * lazily so the database and static paths never pay to load it.
 *
 * Only the handle→wallet binding is authoritative on-chain; presentation
 * fields live off-chain, so `name` falls back to the handle and `bio` stays
 * empty until the indexer or database fills them in. `joined` is likewise left
 * empty: the binding ledger's close time isn't part of the `resolve` response,
 * and inventing a date would be worse than omitting one.
 */
export async function safeChainProfile(handle: string): Promise<Profile | null> {
  if (!isValidHandle(handle) || !isRegistryConfigured()) return null;

  try {
    const { rpc, Account, BASE_FEE, Contract, TransactionBuilder, nativeToScVal, scValToNative } =
      await import('@stellar/stellar-sdk');

    const server = new rpc.Server(SOROBAN_RPC_URL, { allowHttp: ALLOW_HTTP });
    const contract = new Contract(REGISTRY_CONTRACT_ID);
    const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, '0'), {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call('resolve', nativeToScVal(handle, { type: 'string' })))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim) || !sim.result) return null;

    const wallet = decodeResolvedAddress(scValToNative(sim.result.retval));
    if (!wallet) return null;

    return { name: handle, wallet, bio: '', joined: '', source: 'chain' };
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
