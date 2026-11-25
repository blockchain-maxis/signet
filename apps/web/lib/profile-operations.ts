/**
 * Data selection for the profile page's operations section (#899).
 *
 * Two layers, matching the rest of `./profiles.ts`:
 *
 * 1. **Database.** The first page comes from `getPagedOperations` — the same
 *    paginated query the "Load more" button calls — so the heading can report
 *    the real total and the record is complete. Only a page is read here;
 *    `total` is the database's own count, not the size of the page.
 * 2. **Horizon fallback, only when there is no database** (or the handle
 *    resolves to nothing in it). `getOperationsResult` and its per-wallet cap
 *    stay for this path, because there the cap really does bound what we hold,
 *    and `truncated`/`cap` travel through so the page can say so.
 */
import {
  getOperationsResult,
  getPagedOperations,
  type Operation,
  type OperationsSource,
} from './profiles.ts';

/** Operations rendered server-side on the first page. */
export const PROFILE_OPERATIONS_PAGE_SIZE = 25;

export interface ProfileOperationsView {
  /** The operations to render first, newest first (at most one page). */
  operations: Operation[];
  /**
   * The operations stats should aggregate when no database aggregate answers.
   * On the Horizon path that is the whole fetched result, not the rendered
   * page: `computeStats` over a page would silently report a 25-row sample as
   * the account's totals whenever the cap did not cut the record short (#899).
   * On the database path stats come from the database aggregate, so the page
   * stands in for the rows.
   */
  statsOperations: Operation[];
  /** The real number of operations backing the handle, not the page size. */
  total: number;
  /** True when a cap cut the record short — only the Horizon path does this. */
  truncated: boolean;
  /** The cap behind `truncated`, or null when nothing was capped. */
  cap: number | null;
  source: OperationsSource;
}

export interface ProfileOperationsDeps {
  /** Database seam; defaults to the paginated Prisma read. */
  getPagedOperations?: typeof getPagedOperations;
  /** Horizon/capped seam; defaults to the layered `getOperationsResult`. */
  getOperationsResult?: typeof getOperationsResult;
}

/**
 * Choose the profile page's first operations page and completeness metadata.
 * With a database the record is complete (`truncated: false`) and `total` is a
 * real count; without one, the capped read is reported as the partial record
 * it is.
 */
export async function getProfileOperationsView(
  handle: string,
  deps: ProfileOperationsDeps = {},
): Promise<ProfileOperationsView> {
  const paged = await (deps.getPagedOperations ?? getPagedOperations)(
    handle,
    0,
    PROFILE_OPERATIONS_PAGE_SIZE,
  );
  if (paged) {
    return {
      operations: paged.data,
      statsOperations: paged.data,
      total: paged.total,
      truncated: false,
      cap: null,
      source: 'database',
    };
  }

  const result = await (deps.getOperationsResult ?? getOperationsResult)(handle);
  return {
    operations: result.operations.slice(0, PROFILE_OPERATIONS_PAGE_SIZE),
    statsOperations: result.operations,
    total: result.operations.length,
    truncated: result.truncated,
    cap: result.cap,
    source: result.source,
  };
}
