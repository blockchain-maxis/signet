/**
 * `GET /api/v1/profiles` (#969): the handles this deployment can serve, a page
 * at a time, in handle order.
 *
 * The cursor is a keyset on the handle, so a handle claimed while a client
 * pages never shifts or repeats a page. The list has two layers, as the rest
 * of v1 does:
 *
 * - The database, when the deployment has one: every `Profile` that still has
 *   a wallet bound to it. A profile whose wallets were all released keeps its
 *   row, but it is not listed.
 * - With no database, the registry's event stream (`fetchLiveDirectory`). That
 *   is only the bindings the RPC still keeps events for, so the list is marked
 *   `truncated` and has no `total`.
 *
 * A deployment that can answer from neither layer cannot enumerate handles,
 * so it says so (`meta.source: "none"`, `truncated: true`) rather than
 * answering "no handles".
 */
import { HANDLE_PATTERN } from '@signet/types';
import { encodeCursor, V1Error } from './http.ts';

export interface V1ProfileListItem {
  handle: string;
  /** The wallet the handle resolves to; null when the profile has wallets but no primary. */
  primaryWallet: string | null;
  /** When the profile was first seen. Null on the chain layer, which does not know. */
  joinedAt: string | null;
}

export interface V1ProfilesListMeta {
  nextCursor: string | null;
  /** Handles in the whole list; null when the list is known to be partial. */
  total: number | null;
  truncated: boolean;
  /** 'database', 'chain' (the registry's events, with no database), or 'none'. */
  source: 'database' | 'chain' | 'none';
}

/** The keyset a cursor carries: the last handle of the previous page. */
export interface V1ProfilesListCursor {
  handle: string;
}

/** Only profiles that still have a wallet: a release deletes the `Wallet` row. */
const HAS_WALLET = { wallets: { some: {} } } as const;

/**
 * The slice of the Prisma client this read touches, declared as an interface
 * (as `DirectoryStore` in `lib/directory.ts` is) so tests can pass a stub and
 * this module has no hard `@signet/db` import.
 */
export interface ProfilesListStore {
  profile: {
    findMany(args: {
      where: typeof HAS_WALLET & { handle?: { gt: string } };
      orderBy: { handle: 'asc' };
      take: number;
      select: {
        handle: true;
        createdAt: true;
        wallets: { where: { isPrimary: true }; take: 1; select: { pubkey: true } };
      };
    }): Promise<{ handle: string; createdAt: Date; wallets: { pubkey: string }[] }[]>;
    count(args: { where: typeof HAS_WALLET }): Promise<number>;
  };
}

/** Seams for tests: the database and the chain read this endpoint composes. */
export interface V1ProfilesListDeps {
  /**
   * The database to read. `null` says this deployment has none. Left out, it
   * is Prisma when `DATABASE_URL` is set and `null` otherwise.
   */
  store?: ProfilesListStore | null;
  /** The registry's bindings from its event stream; null when it could not be read. */
  fetchLiveDirectory?: () => Promise<{ handle: string; wallet: string }[] | null>;
}

export interface V1ProfilesList {
  data: V1ProfileListItem[];
  meta: V1ProfilesListMeta;
  /**
   * True when the preferred layer failed and a lesser one, or none, answered.
   * Such an answer must not be cached (docs/API_V1.md, "Caching").
   */
  degraded: boolean;
}

/** Lazily loaded so the web app never hard-depends on Postgres being present. */
async function loadPrismaStore(): Promise<ProfilesListStore> {
  const { prisma } = await import('@signet/db');
  return prisma as unknown as ProfilesListStore;
}

async function liveDirectory(): Promise<{ handle: string; wallet: string }[] | null> {
  const { fetchLiveDirectory } = await import('../../directory.ts');
  return fetchLiveDirectory();
}

/** A cursor is only ever one this endpoint issued: a single valid handle. */
function cursorHandle(cursor: V1ProfilesListCursor | null | undefined): string | null {
  if (cursor === null || cursor === undefined) return null;
  const handle = (cursor as { handle?: unknown }).handle;
  if (typeof handle !== 'string' || !HANDLE_PATTERN.test(handle)) {
    throw new V1Error('bad_request', 'Invalid or unparseable pagination cursor.', {
      parameter: 'cursor',
    });
  }
  return handle;
}

const nextCursorAfter = (handle: string): string => encodeCursor<V1ProfilesListCursor>({ handle });

export async function getV1ProfilesList(
  options: { cursor?: V1ProfilesListCursor | null; limit?: number } = {},
  deps: V1ProfilesListDeps = {},
): Promise<V1ProfilesList> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 25));
  const after = cursorHandle(options.cursor);

  const store =
    deps.store !== undefined
      ? deps.store
      : process.env.DATABASE_URL
        ? await loadPrismaStore()
        : null;

  // The database, when there is one. One row past the page says whether
  // another page follows, without a second query.
  let databaseFailed = false;
  if (store) {
    try {
      const [rows, total] = await Promise.all([
        store.profile.findMany({
          where: { ...HAS_WALLET, ...(after !== null && { handle: { gt: after } }) },
          orderBy: { handle: 'asc' },
          take: limit + 1,
          select: {
            handle: true,
            createdAt: true,
            wallets: { where: { isPrimary: true }, take: 1, select: { pubkey: true } },
          },
        }),
        store.profile.count({ where: HAS_WALLET }),
      ]);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        data: page.map((row) => ({
          handle: row.handle,
          primaryWallet: row.wallets[0]?.pubkey ?? null,
          joinedAt: row.createdAt.toISOString(),
        })),
        meta: {
          nextCursor: rows.length > limit && last ? nextCursorAfter(last.handle) : null,
          total,
          truncated: false,
          source: 'database',
        },
        degraded: false,
      };
    } catch {
      // Fall through to the chain, and say the answer is a fallback.
      databaseFailed = true;
    }
  }

  // No database (or one that did not answer): the registry's own events.
  const live = await (deps.fetchLiveDirectory ?? liveDirectory)().catch(() => null);
  if (live === null) {
    return {
      data: [],
      meta: { nextCursor: null, total: null, truncated: true, source: 'none' },
      degraded: true,
    };
  }

  // Plain code-unit order, the same for the sort and for the cursor.
  const all = live
    .filter((entry) => HANDLE_PATTERN.test(entry.handle))
    .sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
  const rest = after === null ? all : all.filter((entry) => entry.handle > after);
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  return {
    data: page.map((entry) => ({
      handle: entry.handle,
      primaryWallet: entry.wallet || null,
      joinedAt: null,
    })),
    meta: {
      nextCursor: rest.length > limit && last ? nextCursorAfter(last.handle) : null,
      // The event stream reaches back only as far as the RPC keeps events, so
      // this is never the whole registry and no count of it would be honest.
      total: null,
      truncated: true,
      source: 'chain',
    },
    degraded: databaseFailed,
  };
}
