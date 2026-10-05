/**
 * Contract activity data layer (C-10, #452): what the Activity tab reads.
 *
 * Two reads, both database-only (there is no Horizon fallback: Horizon rejects
 * `transactions().forAccount(C…)`, and the per-contract call index exists only
 * in `ContractInvocation`, #417):
 *
 * - `getContractActivity`: the newest `ContractSnapshot`. Since #429 its counts
 *   come from `ContractInvocation`, so `txCountTotal` covers only the calls since
 *   `countedSince`, and it is a floor when `totalIsFloor` is set (render "{n}+",
 *   following `formatCount` in `./profiles.ts`, always with "since …"). A
 *   snapshot with a null `countedSince` was written before #429, when every
 *   count was a zero that meant "not measured": it is returned as `null`,
 *   never as "no usage".
 * - `getContractInvocations`: a page of calls made to the contract, shaped like
 *   the `Operation` rows `OperationsList` renders. `sourceAccounts` narrows it
 *   to given callers (the handle's wallets: "this developer's calls").
 *
 * `getContractOperationsPage` is the route's logic with the attribution gate in
 * front, kept here so it is testable without Next.js.
 *
 * The "contract id" arguments are the `C…` address, scoped by network, as
 * `Contract` is unique on that pair.
 */
import { isValidHandle, type Network } from '@signet/types';
import { STELLAR_NETWORK } from './chain.ts';
import { attributeContract, type Attribution } from './contract-attribution.ts';
import type { Operation } from './profiles.ts';

/** Where an activity read was answered: the database, or nothing could. */
export type ActivitySource = 'database' | 'none';

export interface ContractActivitySnapshot {
  txCount24h: number;
  /** Calls since `countedSince`, not since deployment; a floor when `totalIsFloor`. */
  txCountTotal: number;
  /** True when `txCountTotal` is a lower bound: render "{n}+". */
  totalIsFloor: boolean;
  /** Oldest captured call the counts cover; always set on a returned snapshot. */
  countedSince: Date;
  lastActivity: Date | null;
  capturedAt: Date;
}

export interface ContractActivity {
  snapshot: ContractActivitySnapshot | null;
  source: ActivitySource;
}

/** A `ContractSnapshot` row as the seam returns it. */
export interface SnapshotRow {
  txCount24h: number;
  txCountTotal: number;
  totalIsFloor: boolean;
  countedSince: Date | null;
  lastActivity: Date | null;
  capturedAt: Date;
}

/** A `ContractInvocation` row as the seam returns it. */
export interface InvocationRow {
  id: string;
  function: string | null;
  sourceAccount: string;
  createdAt: Date;
  txHash: string;
  successful: boolean;
}

export interface ContractInvocationsPage {
  data: Operation[];
  /** True number of matching calls, not capped to the page. */
  total: number;
  source: ActivitySource;
}

export interface InvocationsQuery {
  offset: number;
  limit: number;
  /** Restrict to these callers. An empty list matches nothing. */
  sourceAccounts?: string[];
}

/**
 * Database seam. Each method returns `undefined` when there is no database
 * (`DATABASE_URL` unset or the query failed), so callers report `source: 'none'`.
 */
export interface ContractActivityDb {
  /** Snapshots for the contract, any order; the caller picks the newest. */
  listSnapshots: (args: { address: string; network: string }) => Promise<SnapshotRow[] | undefined>;
  listInvocations: (args: {
    address: string;
    network: string;
    offset: number;
    limit: number;
    sourceAccounts?: string[];
  }) => Promise<{ rows: InvocationRow[]; total: number } | undefined>;
  /** Pubkeys of every wallet bound to the handle, `undefined` without a database. */
  listHandleWallets: (handle: string) => Promise<string[] | undefined>;
}

export interface ContractActivityDeps {
  network?: Network;
  db?: ContractActivityDb;
}

const defaultDb: ContractActivityDb = {
  listSnapshots: async ({ address, network }) => {
    if (!process.env.DATABASE_URL) return undefined;
    try {
      const { prisma } = await import('@signet/db');
      return await prisma.contractSnapshot.findMany({
        where: { contract: { address, network } },
        orderBy: { capturedAt: 'desc' },
        take: 1,
      });
    } catch {
      return undefined;
    }
  },
  listInvocations: async ({ address, network, offset, limit, sourceAccounts }) => {
    if (!process.env.DATABASE_URL) return undefined;
    try {
      const { prisma } = await import('@signet/db');
      const where = {
        contract: { address, network },
        ...(sourceAccounts ? { sourceAccount: { in: sourceAccounts } } : {}),
      };
      const [rows, total] = await Promise.all([
        prisma.contractInvocation.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: offset,
          take: limit,
        }),
        prisma.contractInvocation.count({ where }),
      ]);
      return { rows, total };
    } catch {
      return undefined;
    }
  },
  listHandleWallets: async (handle) => {
    if (!process.env.DATABASE_URL || !isValidHandle(handle)) return undefined;
    try {
      const { prisma } = await import('@signet/db');
      const profile = await prisma.profile.findUnique({
        where: { handle: handle.toLowerCase() },
        include: { wallets: { select: { pubkey: true } } },
      });
      return profile ? profile.wallets.map((w) => w.pubkey) : undefined;
    } catch {
      return undefined;
    }
  },
};

/** The newest snapshot for a contract, or `null` when it is absent or unmeasured. */
export async function getContractActivity(
  contractId: string,
  deps: ContractActivityDeps = {},
): Promise<ContractActivity> {
  const db = deps.db ?? defaultDb;
  const rows = await db.listSnapshots({
    address: contractId,
    network: deps.network ?? STELLAR_NETWORK,
  });
  if (!rows) return { snapshot: null, source: 'none' };

  // Newest wins. Only the newest is judged: if it is unmeasured, an older row
  // cannot stand in for it (they are all pre-#429 zeros too).
  const newest = rows.reduce<SnapshotRow | null>(
    (best, row) => (!best || row.capturedAt > best.capturedAt ? row : best),
    null,
  );
  // Null `countedSince` means "not measured" (pre-#429), never "no usage".
  if (!newest || !newest.countedSince) return { snapshot: null, source: 'database' };

  return {
    snapshot: {
      txCount24h: newest.txCount24h,
      txCountTotal: newest.txCountTotal,
      totalIsFloor: newest.totalIsFloor,
      countedSince: newest.countedSince,
      lastActivity: newest.lastActivity,
      capturedAt: newest.capturedAt,
    },
    source: 'database',
  };
}

/** Map a `ContractInvocation` row to the `Operation` shape `OperationsList` renders. */
function mapInvocation(row: InvocationRow): Operation {
  return {
    id: row.id,
    type: 'invoke_host_function',
    function: row.function ?? undefined,
    source_account: row.sourceAccount,
    created_at: row.createdAt.toISOString(),
    transaction_hash: row.txHash,
    transaction_successful: row.successful,
  };
}

/** A page of calls made to the contract, newest first. */
export async function getContractInvocations(
  contractId: string,
  query: InvocationsQuery,
  deps: ContractActivityDeps = {},
): Promise<ContractInvocationsPage> {
  // No callers to match is an honest empty list, not "every caller".
  if (query.sourceAccounts && query.sourceAccounts.length === 0) {
    return { data: [], total: 0, source: 'database' };
  }
  const db = deps.db ?? defaultDb;
  const result = await db.listInvocations({
    address: contractId,
    network: deps.network ?? STELLAR_NETWORK,
    offset: query.offset,
    limit: query.limit,
    sourceAccounts: query.sourceAccounts,
  });
  if (!result) return { data: [], total: 0, source: 'none' };
  return { data: result.rows.map(mapInvocation), total: result.total, source: 'database' };
}

/** Clamp `offset`/`limit` query params the way the profile operations route does. */
export function parsePaging(params: URLSearchParams): { offset: number; limit: number } {
  return {
    offset: Math.max(0, parseInt(params.get('offset') ?? '0', 10) || 0),
    limit: Math.min(100, Math.max(1, parseInt(params.get('limit') ?? '25', 10) || 25)),
  };
}

export interface ContractOperationsMeta {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  truncated: boolean;
  cap: number | null;
  source: ActivitySource;
}

export type ContractOperationsResponse =
  | { status: 200; body: { data: Operation[]; meta: ContractOperationsMeta } }
  | { status: 404 | 503; body: { error: string } };

export interface ContractOperationsPageDeps extends ContractActivityDeps {
  /** Attribution gate. Defaults to `attributeContract`. */
  attribute?: (handle: string, address: string) => Promise<Attribution>;
}

function emptyPage(
  offset: number,
  limit: number,
  source: ActivitySource,
): ContractOperationsResponse {
  return {
    status: 200,
    body: {
      data: [],
      meta: { total: 0, offset, limit, hasMore: false, truncated: false, cap: null, source },
    },
  };
}

/**
 * The route's logic: attribution first (a contract the handle does not own, or
 * a malformed address, is a 404; an unavailable lookup is a 503), then the
 * invocation page, restricted to the handle's wallets when `mine` is set.
 */
export async function getContractOperationsPage(
  handle: string,
  address: string,
  params: URLSearchParams,
  deps: ContractOperationsPageDeps = {},
): Promise<ContractOperationsResponse> {
  const attribution = await (deps.attribute ?? attributeContract)(handle, address);
  if (attribution.status === 'invalid' || attribution.status === 'not-attributed') {
    return { status: 404, body: { error: 'Contract not found' } };
  }
  if (attribution.status === 'unavailable') {
    return { status: 503, body: { error: 'Contract lookup unavailable' } };
  }

  const { offset, limit } = parsePaging(params);
  let sourceAccounts: string[] | undefined;
  if (params.get('mine') === '1') {
    const db = deps.db ?? defaultDb;
    const wallets = await db.listHandleWallets(handle);
    // No database to resolve the wallets: nothing can answer, so say so
    // rather than report an empty database.
    if (!wallets) return emptyPage(offset, limit, 'none');
    sourceAccounts = wallets;
  }

  const page = await getContractInvocations(address, { offset, limit, sourceAccounts }, deps);
  return {
    status: 200,
    body: {
      data: page.data,
      meta: {
        total: page.total,
        offset,
        limit,
        hasMore: offset + limit < page.total,
        // The database counts every row, so nothing is capped.
        truncated: false,
        cap: null,
        source: page.source,
      },
    },
  };
}
