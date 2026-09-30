/**
 * Profile contracts list (C-13, #455): every contract a handle's wallets
 * deployed, for the "Deployed contracts" section of `/p/{handle}`.
 *
 * The profile stays a summary by design (CONTRACT_DOCS_DESIGN.md §2.1,
 * CONTRACT_VISUALISER_DESIGN.md §4.1): rows link to
 * `/p/{handle}/contract/{address}` and carry no interface detail.
 *
 * Two layers, mirroring `getProfile` in `./profiles.ts` and the attribution
 * rule in `./contract-attribution.ts` (#444):
 *
 * 1. **Database.** `Contract` rows for any of the handle's wallets (not just
 *    the primary one), filtered to the configured network, newest deploy
 *    first. A reachable DB answers authoritatively: rows or an honest empty
 *    list, never a Horizon fallback.
 * 2. **Horizon, only when there is no database** (`DATABASE_URL` unset or the
 *    DB unreachable). The bound wallet's operations are walked for
 *    `invoke_host_function` records whose `function` is
 *    `HostFunctionTypeCreateContract` — the same filter the indexer's
 *    deployment worker uses — and each created address is derived from the
 *    record's `address`/`salt` or decoded from result meta, the #444 walk.
 *    The walk stops at `HORIZON_MAX_RECORDS`, with `truncated` carried
 *    through so the section can say partial like the operations list does.
 */
import { isValidHandle, networkPassphrase, normalizeNetwork, type Network } from '@signet/types';
import { STELLAR_NETWORK } from './chain.ts';
import { getConfiguredNetwork } from './cli-link.ts';
import { deriveContractId } from './contract-address.ts';
import { decodeContractAddressFromMeta } from './contract-attribution.ts';
import { getProfile } from './profiles.ts';
import { HORIZON_MAX_RECORDS } from './server/horizon.ts';

/** A deployed contract row, ready for the profile section to render. */
export interface ProfileContract {
  address: string;
  /** ISO-8601 deploy time. */
  deployedAt: string;
  deployTxHash: string;
  /** Wallet that deployed it: DB wallet pubkey, or the walked wallet on Horizon. */
  deployerPubkey: string;
  /** Which layer answered for this row. */
  source: 'database' | 'horizon';
  /** Indexed WASM hash from the DB, null on the Horizon path. */
  wasmHash: string | null;
}

export interface ProfileContractsResult {
  /** Contracts deployed by the handle's wallets, newest deploy first. */
  contracts: ProfileContract[];
  /** Which layer answered; `none` when nothing did. */
  source: 'database' | 'horizon' | 'none';
  /** True when a cap cut the record short — the list is a partial history. */
  truncated: boolean;
  /** The cap that produced the truncation, or null when nothing was capped. */
  cap: number | null;
  /** True when the handle has more than one wallet (the section then names each row's deployer). */
  multiWallet: boolean;
}

/** Minimal `Contract` row projection the listing query needs. */
export interface ProfileContractsDbRow {
  address: string;
  network: string;
  deployerPubkey: string;
  deployTxHash: string;
  deployedAt: Date | string;
  wasmHash: string | null;
  walletId: string;
  walletPubkey: string;
}

/**
 * Database seam. Returns the handle's wallets' contracts with the wallet
 * count (needed for the multi-wallet display rule even when there are no
 * contracts), or `undefined` when there is no database at all
 * (`DATABASE_URL` unset or unreachable) — and when the handle resolves to no
 * profile row, so the Horizon fallback still gets its chance.
 */
export interface ProfileContractsDb {
  listContracts: (args: {
    handle: string;
  }) => Promise<{ contracts: ProfileContractsDbRow[]; walletCount: number } | undefined>;
}

/** Minimal Horizon operation shape the listing walk needs. */
export interface ProfileContractsHorizonOp {
  type: string;
  function?: string;
  /** Present when the record carries the create-contract inputs directly. */
  address?: string | null;
  /** Present when the record carries the create-contract inputs directly. */
  salt?: string | null;
  transactionHash?: string | null;
  /** ISO-8601 creation time of the operation. */
  createdAt: string;
}

/**
 * Horizon seam, mirroring `./contract-attribution.ts`: tests inject fakes, so
 * no test needs the network.
 */
export interface ProfileContractsHorizon {
  /** The handle's bound wallet, or null when it cannot be resolved. */
  boundWallet: (handle: string) => Promise<string | null>;
  /**
   * Operations for one wallet. Returns `null` when the wallet has no readable
   * history (e.g. unfunded account); throws on transport failure, which
   * surfaces as `unavailable`.
   */
  listOperations: (
    wallet: string,
  ) => Promise<{ operations: ProfileContractsHorizonOp[]; truncated: boolean } | null>;
  /**
   * Base64 `result_meta_xdr` for a transaction, or `null` when the transaction
   * has none to offer. Throws on transport failure.
   */
  getResultMetaXdr: (txHash: string) => Promise<string | null>;
}

export interface ProfileContractsDeps {
  /** Canonical network contracts must belong to. Defaults to `STELLAR_NETWORK`. */
  network?: Network;
  /** Database seam. Defaults to the Prisma-backed lookup, gated on `DATABASE_URL`. */
  db?: ProfileContractsDb;
  /** Horizon seam. Defaults to live Horizon fetchers. */
  horizon?: ProfileContractsHorizon;
}

const CREATE_CONTRACT_FUNCTION = 'HostFunctionTypeCreateContract';

const defaultDb: ProfileContractsDb = {
  listContracts: async ({ handle }) => {
    if (!process.env.DATABASE_URL) return undefined;
    try {
      const { prisma } = await import('@signet/db');
      const profile = await prisma.profile.findUnique({
        where: { handle: handle.toLowerCase() },
        include: {
          wallets: {
            include: { contracts: { orderBy: { deployedAt: 'desc' } } },
          },
        },
      });
      if (!profile) return undefined;
      // The Prisma client is untyped here when `@prisma/client` was never
      // generated, so the row shapes are annotated structurally rather than
      // inferred — the seam types above stay the contract tests assert on.
      type DbWallet = {
        pubkey: string;
        contracts: Array<{
          address: string;
          network: string;
          deployerPubkey: string;
          deployTxHash: string;
          deployedAt: Date;
          wasmHash: string | null;
          walletId: string;
        }>;
      };
      const wallets = profile.wallets as DbWallet[];
      return {
        contracts: wallets.flatMap((w) =>
          w.contracts.map((c) => ({ ...c, walletPubkey: w.pubkey })),
        ),
        walletCount: wallets.length,
      };
    } catch {
      return undefined;
    }
  },
};

const defaultHorizon: ProfileContractsHorizon = {
  boundWallet: async (handle: string) => {
    const profile = await getProfile(handle);
    return profile?.wallet ? profile.wallet : null;
  },
  listOperations: async (wallet: string) => {
    const { fetchHorizonOperations } = await import('./server/horizon.ts');
    const res = await fetchHorizonOperations(wallet);
    if (!res) return null;
    return {
      operations: res.operations.map((op) => ({
        type: op.type,
        function: op.function,
        transactionHash: op.transaction_hash ?? null,
        createdAt: op.created_at,
      })),
      truncated: res.truncated,
    };
  },
  getResultMetaXdr: async (txHash: string) => {
    const { HORIZON_URL } = await import('./server/horizon.ts');
    const res = await fetch(
      `${HORIZON_URL.replace(/\/$/, '')}/transactions/${encodeURIComponent(txHash)}`,
      {
        headers: { Accept: 'application/json' },
        next: { revalidate: 300 },
      },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Horizon transaction fetch failed: ${res.status}`);
    const body = (await res.json()) as { result_meta_xdr?: unknown };
    return typeof body.result_meta_xdr === 'string' ? body.result_meta_xdr : null;
  },
};

/**
 * Derive the created contract ID for one create-contract operation: from the
 * record's `address`/`salt` fields when present, else by fetching the
 * transaction and decoding its result meta. Returns null when neither path
 * yields an address. A failed decode is an ordinary miss, not an outage.
 */
async function deriveCreatedAddress(
  op: ProfileContractsHorizonOp,
  deployer: string,
  passphrase: string,
  horizon: ProfileContractsHorizon,
): Promise<string | null> {
  const fromAddress = op.address ?? deployer;
  if (op.salt) {
    try {
      return deriveContractId({
        deployer: fromAddress,
        salt: op.salt,
        networkPassphrase: passphrase,
      });
    } catch {
      // Fall through to the transaction path below.
    }
  }
  if (!op.transactionHash) return null;
  const metaXdr = await horizon.getResultMetaXdr(op.transactionHash);
  if (!metaXdr) return null;
  const decoded = decodeContractAddressFromMeta(metaXdr);
  return decoded.ok ? decoded.address : null;
}

async function listFromHorizon(
  handle: string,
  network: Network,
  horizon: ProfileContractsHorizon,
): Promise<ProfileContractsResult> {
  const empty: ProfileContractsResult = {
    contracts: [],
    source: 'none',
    truncated: false,
    cap: null,
    multiWallet: false,
  };
  const wallet = await horizon.boundWallet(handle);
  // Contract-controlled identities are covered only through the DB (same rule
  // as #444): the Horizon walk is G… wallets alone.
  if (!wallet || !wallet.startsWith('G')) return empty;
  const page = await horizon.listOperations(wallet);
  if (!page) return empty;

  const passphrase = networkPassphrase(network);
  const contracts: ProfileContract[] = [];
  let scanned = 0;
  let truncated = page.truncated;
  for (const op of page.operations) {
    if (scanned >= HORIZON_MAX_RECORDS) {
      truncated = true;
      break;
    }
    scanned += 1;
    if (op.type !== 'invoke_host_function' || op.function !== CREATE_CONTRACT_FUNCTION) {
      continue;
    }
    const address = await deriveCreatedAddress(op, wallet, passphrase, horizon);
    if (!address) continue;
    contracts.push({
      address,
      deployedAt: op.createdAt,
      deployTxHash: op.transactionHash ?? '',
      deployerPubkey: wallet,
      source: 'horizon',
      wasmHash: null,
    });
  }
  contracts.sort((a, b) =>
    a.deployedAt < b.deployedAt ? 1 : a.deployedAt > b.deployedAt ? -1 : 0,
  );
  return {
    contracts,
    source: 'horizon',
    truncated,
    cap: truncated ? HORIZON_MAX_RECORDS : null,
    multiWallet: false,
  };
}

/**
 * Contracts listing with injectable seams — the entry point tests use, so no
 * test needs a database or the network.
 */
export async function getProfileContractsWithDeps(
  handle: string,
  deps: ProfileContractsDeps = {},
): Promise<ProfileContractsResult> {
  const empty: ProfileContractsResult = {
    contracts: [],
    source: 'none',
    truncated: false,
    cap: null,
    multiWallet: false,
  };
  if (!isValidHandle(handle)) return empty;

  const network = deps.network ?? STELLAR_NETWORK;
  const db = deps.db ?? defaultDb;

  let dbRes: { contracts: ProfileContractsDbRow[]; walletCount: number } | undefined;
  try {
    dbRes = await db.listContracts({ handle });
  } catch {
    dbRes = undefined;
  }
  // The database is authoritative when reachable: rows or an honest empty
  // list, never a Horizon fallback.
  if (dbRes) {
    const contracts = dbRes.contracts
      .filter((row) => row.network === network)
      .sort((a, b) => {
        const at = a.deployedAt instanceof Date ? a.deployedAt.getTime() : Date.parse(a.deployedAt);
        const bt = b.deployedAt instanceof Date ? b.deployedAt.getTime() : Date.parse(b.deployedAt);
        return bt - at;
      })
      .map((row) => ({
        address: row.address,
        deployedAt: row.deployedAt instanceof Date ? row.deployedAt.toISOString() : row.deployedAt,
        deployTxHash: row.deployTxHash,
        deployerPubkey: row.deployerPubkey,
        source: 'database' as const,
        wasmHash: row.wasmHash,
      }));
    return {
      contracts,
      source: 'database',
      truncated: false,
      cap: null,
      multiWallet: dbRes.walletCount > 1,
    };
  }

  // No database (unset DATABASE_URL, unreachable, or no profile row): fall
  // back to the Horizon walk over the bound wallet.
  const horizon = deps.horizon ?? defaultHorizon;
  try {
    return await listFromHorizon(handle, network, horizon);
  } catch {
    return empty;
  }
}

/**
 * Deployed contracts for a handle's profile section: DB rows for all of the
 * profile's wallets on the configured network, newest deploy first — or the
 * Horizon fallback over the bound wallet when there is no database.
 */
export async function getProfileContracts(handle: string): Promise<ProfileContractsResult> {
  return getProfileContractsWithDeps(handle);
}

/**
 * Best-effort list of attributed contracts for the configured network.
 * Returns [] without a DB or if the query fails, like `safeDbHandles`.
 */
export async function listAttributedContracts(): Promise<
  { handle: string; address: string; deployedAt: Date }[]
> {
  if (!process.env.DATABASE_URL) return [];
  try {
    const { prisma } = await import('@signet/db');
    const network = normalizeNetwork(getConfiguredNetwork());

    const contracts = await prisma.contract.findMany({
      where: { network },
      select: {
        address: true,
        deployedAt: true,
        wallet: {
          select: {
            profile: {
              select: {
                handle: true,
              },
            },
          },
        },
      },
    });

    return contracts.map((c) => ({
      handle: c.wallet.profile.handle,
      address: c.address,
      deployedAt: c.deployedAt,
    }));
  } catch {
    return [];
  }
}
