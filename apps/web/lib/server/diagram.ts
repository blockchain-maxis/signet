/**
 * @file apps/web/lib/server/diagram.ts
 *
 * Resolves and caches contract diagram layouts by (wasmHash, layoutVersion)
 * (#497, docs/CONTRACT_VISUALISER_DESIGN.md §4.2, §4.4).
 *
 * Layout calculation is a pure function of the contract spec. It is cached
 * alongside the spec so repeated renders do not recompute it. The cache key
 * includes `layoutVersion` from `@signet/visualiser` so algorithm improvements
 * invalidate and recompute stale diagrams automatically.
 *
 * Storage uses `ContractSpec` (layout and layoutVersion columns) when Postgres
 * is available, and falls back to an in-memory LRU cache when no database is
 * configured (matching the pattern in `lib/rate-limit.ts`).
 *
 * Layout failures are caught, logged via `lib/logger.ts`, and return
 * `{ ok: false }`. They never throw into the page (design §2.4).
 */

import { fromSpecJson, LruSpecCache, type ContractSpec } from '@signet/spec';
import {
  buildContractGraph,
  layoutContractGraph,
  LAYOUT_VERSION,
  type ContractGraph,
  type PositionedDiagramModel,
} from '@signet/visualiser';
import { loadContractSpec, type ContractSpecResult } from './contract-spec.ts';
import { logger } from '../logger.ts';

export interface StoredDiagramLayout {
  readonly layout: PositionedDiagramModel;
  readonly layoutVersion: number;
}

export interface DiagramStore {
  get(wasmHash: string): Promise<StoredDiagramLayout | null | undefined>;
  set(wasmHash: string, layout: PositionedDiagramModel, layoutVersion: number): Promise<void>;
  clear?(): void;
}

/**
 * In-memory LRU store used when `DATABASE_URL` is unset (local dev and tests),
 * mirroring the fallback pattern in `lib/rate-limit.ts`.
 */
export class MemoryDiagramStore implements DiagramStore {
  private cache = new LruSpecCache<StoredDiagramLayout>();

  async get(wasmHash: string): Promise<StoredDiagramLayout | undefined> {
    return this.cache.get(wasmHash);
  }

  async set(
    wasmHash: string,
    layout: PositionedDiagramModel,
    layoutVersion: number,
  ): Promise<void> {
    await this.cache.set(wasmHash, { layout, layoutVersion });
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * Postgres-backed store over the `ContractSpec` table.
 * Caches in-memory first for performance and reads/writes `layout` and
 * `layoutVersion` in the database when available.
 */
export class PrismaDiagramStore implements DiagramStore {
  private memory = new MemoryDiagramStore();
  private readonly injected?: any;

  constructor(store?: any) {
    this.injected = store;
  }

  private async db() {
    if (this.injected) return this.injected;
    if (!process.env.DATABASE_URL) return null;
    const { prisma } = await import('@signet/db');
    return prisma as any;
  }

  async get(wasmHash: string): Promise<StoredDiagramLayout | null | undefined> {
    const mem = await this.memory.get(wasmHash);
    if (mem) return mem;

    const db = await this.db();
    if (!db) return undefined;

    try {
      const row = await db.contractSpec.findUnique({
        where: { wasmHash },
        select: { layout: true, layoutVersion: true },
      });
      if (!row || !row.layout || typeof row.layoutVersion !== 'number') return null;

      const stored: StoredDiagramLayout = {
        layout: row.layout as unknown as PositionedDiagramModel,
        layoutVersion: row.layoutVersion,
      };
      await this.memory.set(wasmHash, stored.layout, stored.layoutVersion);
      return stored;
    } catch {
      return null;
    }
  }

  async set(
    wasmHash: string,
    layout: PositionedDiagramModel,
    layoutVersion: number,
  ): Promise<void> {
    await this.memory.set(wasmHash, layout, layoutVersion);

    const db = await this.db();
    if (!db) return;

    try {
      await db.contractSpec.update({
        where: { wasmHash },
        data: {
          layout: layout as unknown as any,
          layoutVersion,
        },
      });
    } catch {
      // Fail soft if the row does not exist or database update fails
    }
  }

  clear(): void {
    this.memory.clear();
  }
}

let store: DiagramStore = new MemoryDiagramStore();
let storeResolved = false;
let initPromise: Promise<void> | null = null;

export function setDiagramStore(s: DiagramStore): void {
  store = s;
  storeResolved = true;
}

function ensureStore(): Promise<void> {
  if (storeResolved) return Promise.resolve();
  if (!initPromise) {
    initPromise = (async () => {
      if (process.env.DATABASE_URL) {
        setDiagramStore(new PrismaDiagramStore());
      }
      storeResolved = true;
    })();
  }
  return initPromise;
}

export function __resetDiagramStore(): void {
  if (store instanceof MemoryDiagramStore) store.clear();
  else store = new MemoryDiagramStore();
  storeResolved = false;
  initPromise = null;
}

export type DiagramResult =
  | {
      readonly ok: true;
      readonly layout: PositionedDiagramModel;
      readonly wasmHash: string;
      readonly layoutVersion: number;
    }
  | {
      readonly ok: false;
      readonly failure?: unknown;
    };

export interface DiagramDeps {
  wasmHash?: string | null;
  getContractSpec?: (request: {
    address: string;
    network: string;
    wasmHash?: string | null;
  }) => Promise<ContractSpecResult>;
  getSpec?: (request: {
    address: string;
    network: string;
    wasmHash?: string | null;
  }) => Promise<ContractSpecResult>;
  layout?: (graph: ContractGraph) => PositionedDiagramModel;
  computeLayout?: (graph: ContractGraph) => PositionedDiagramModel;
  buildGraph?: (spec: ContractSpec) => ContractGraph;
  store?: DiagramStore;
  layoutVersion?: number;
}

/**
 * Resolves a contract's interface and computes or loads its diagram layout.
 *
 * Cached by `(wasmHash, layoutVersion)`. If the cached version does not match
 * the running layout algorithm version, the layout is recomputed and saved.
 *
 * Layout failures are caught and logged via `lib/logger.ts`, returning `{ ok: false }`.
 * They never throw into the page.
 */
export async function getDiagram(
  address: string,
  network: string,
  deps: DiagramDeps = {},
): Promise<DiagramResult> {
  try {
    const resolveSpec = deps.getContractSpec ?? deps.getSpec ?? loadContractSpec;
    const specResult = await resolveSpec({
      address,
      network,
      wasmHash: deps.wasmHash ?? null,
    });

    if (!specResult.ok) {
      return { ok: false, failure: specResult.failure };
    }

    const wasmHash = specResult.wasmHash;
    const targetVersion = deps.layoutVersion ?? LAYOUT_VERSION;

    await ensureStore();
    const activeStore = deps.store ?? store;

    const cached = await activeStore.get(wasmHash);
    if (cached && cached.layoutVersion === targetVersion && cached.layout) {
      return {
        ok: true,
        layout: cached.layout,
        wasmHash,
        layoutVersion: targetVersion,
      };
    }

    try {
      const build = deps.buildGraph ?? buildContractGraph;
      const layoutFn = deps.computeLayout ?? deps.layout ?? layoutContractGraph;
      const graph = build(fromSpecJson(specResult.spec));
      const layout = layoutFn(graph);

      await activeStore.set(wasmHash, layout, targetVersion);

      return {
        ok: true,
        layout,
        wasmHash,
        layoutVersion: targetVersion,
      };
    } catch (layoutError) {
      logger.warn(
        { address, network, wasmHash, error: layoutError },
        'failed to compute diagram layout',
      );
      return { ok: false };
    }
  } catch (error) {
    logger.warn({ address, network, error }, 'unexpected error in getDiagram');
    return { ok: false };
  }
}
