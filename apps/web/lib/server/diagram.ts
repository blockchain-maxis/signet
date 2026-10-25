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

import {
  classifyFunctions,
  fromSpecJson,
  LruSpecCache,
  normaliseFootprint,
  type ContractSpec,
  type FootprintObservation,
  type MutabilityMark,
} from '@signet/spec';
import {
  buildContractGraph,
  layoutContractGraph,
  LAYOUT_VERSION,
  type ContractGraph,
  type PositionedDiagramModel,
} from '@signet/visualiser';
import { Address, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { loadContractSpec, type ContractSpecResult } from './contract-spec.ts';
import { logger } from '../logger.ts';
import { resolveNetwork, stellarExpertContractUrl } from '../network.ts';
import { ALLOW_HTTP, SOROBAN_RPC_URL } from '../chain.ts';

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

// ── Callee labels (#517) ───────────────────────────────────────────────

/**
 * What a callee contract can honestly be called, from chain data or Signet's
 * own `Contract` rows and nothing else: no curated names, no guesses.
 */
export type CalleeLabel =
  | {
      readonly kind: 'asset';
      readonly address: string;
      /** `"USDC (asset contract, issuer G…ABCD)"`, or the native asset's. */
      readonly text: string;
      readonly href: string;
    }
  | {
      readonly kind: 'signet';
      readonly address: string;
      readonly handle: string;
      /** `"deployed by @handle"`. */
      readonly text: string;
      /** The contract's Signet page, `/p/{handle}/contract/{address}`. */
      readonly href: string;
    }
  | {
      readonly kind: 'address';
      readonly address: string;
      /** The short address. */
      readonly text: string;
      /** Stellar Expert. */
      readonly href: string;
    };

/** Just the slice of `rpc.Server` labelling needs, so tests can stub it. */
export interface LedgerEntriesServer {
  getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<{
    entries: readonly { key: xdr.LedgerKey; val: xdr.LedgerEntryData }[];
  }>;
}

export interface CalleeLabelDeps {
  server?: LedgerEntriesServer;
  /** Signet-deployed contracts among `addresses` on `network`, with the deploying profile's handle. */
  findSignetContracts?: (
    addresses: readonly string[],
    network: string,
  ) => Promise<readonly { address: string; handle: string }[]>;
  now?: () => number;
}

/** What chain data says about one address: a SAC's asset, or that it is no SAC. */
type ChainIdentity = { readonly asset: string | null; readonly issuer: string | null } | null;

/** A SAC's identity never changes, and neither does a WASM contract's not being one. */
const CHAIN_LABEL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHAIN_LABEL_CAPACITY = 5000;
/** `getLedgerEntries` takes at most 200 keys per request. */
const LEDGER_ENTRIES_BATCH = 200;

const chainIdentities = new Map<string, { identity: ChainIdentity; expires: number }>();

export function __resetCalleeLabels(): void {
  chainIdentities.clear();
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function instanceKey(address: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(address).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/**
 * A contract instance's chain identity: for a Stellar Asset Contract, the
 * asset its `METADATA` names (`native`, or `CODE:ISSUER`, as the host writes
 * it); for any other executable, `null`.
 */
function identityOf(data: xdr.LedgerEntryData): ChainIdentity {
  const instance = data.contractData().val().instance();
  if (instance.executable().switch().name !== 'contractExecutableStellarAsset') return null;
  for (const item of instance.storage() ?? []) {
    const key = scValToNative(item.key());
    if (key !== 'METADATA') continue;
    const name = (scValToNative(item.val()) as { name?: unknown }).name;
    if (name === 'native') return { asset: 'XLM', issuer: null };
    if (typeof name === 'string' && name.includes(':')) {
      const [code, issuer] = name.split(':');
      return { asset: code!, issuer: issuer! };
    }
  }
  return { asset: null, issuer: null };
}

async function defaultSignetContracts(
  addresses: readonly string[],
  network: string,
): Promise<readonly { address: string; handle: string }[]> {
  if (!process.env.DATABASE_URL) return [];
  const { prisma } = await import('@signet/db');
  const rows = await prisma.contract.findMany({
    where: { address: { in: [...addresses] }, network },
    select: { address: true, wallet: { select: { profile: { select: { handle: true } } } } },
  });
  return rows.map((r) => ({ address: r.address, handle: r.wallet.profile.handle }));
}

/**
 * Labels for callee contracts (#517), one per address, in plain language:
 * a Stellar Asset Contract by its asset, a contract a Signet profile deployed
 * by that profile's handle, anything else by its short address. Chain
 * identity comes from one batched `getLedgerEntries` over the callees'
 * instances and is cached for a long TTL; Signet ownership is read from the
 * `Contract` rows on every call, never cached. An instance RPC cannot return
 * (archived, missing, or RPC down) is labelled by its address and not cached.
 */
export async function labelCallees(
  addresses: readonly string[],
  network: string,
  deps: CalleeLabelDeps = {},
): Promise<Map<string, CalleeLabel>> {
  const unique = [...new Set(addresses)];
  const now = (deps.now ?? Date.now)();
  const explorer = resolveNetwork(network).explorer;

  const identities = new Map<string, ChainIdentity>();
  const unresolved: string[] = [];
  for (const address of unique) {
    const cached = chainIdentities.get(`${network}:${address}`);
    if (cached && cached.expires > now) identities.set(address, cached.identity);
    else unresolved.push(address);
  }
  if (unresolved.length > 0) {
    try {
      const server = deps.server ?? new rpc.Server(SOROBAN_RPC_URL, { allowHttp: ALLOW_HTTP });
      for (let i = 0; i < unresolved.length; i += LEDGER_ENTRIES_BATCH) {
        const batch = unresolved.slice(i, i + LEDGER_ENTRIES_BATCH);
        const response = await server.getLedgerEntries(...batch.map(instanceKey));
        for (const entry of response.entries) {
          const address = Address.fromScAddress(entry.key.contractData().contract()).toString();
          const identity = identityOf(entry.val);
          identities.set(address, identity);
          chainIdentities.delete(`${network}:${address}`);
          chainIdentities.set(`${network}:${address}`, {
            identity,
            expires: now + CHAIN_LABEL_TTL_MS,
          });
        }
      }
      while (chainIdentities.size > CHAIN_LABEL_CAPACITY) {
        chainIdentities.delete(chainIdentities.keys().next().value!);
      }
    } catch (error) {
      logger.warn({ network, error }, 'callee labels: ledger entries unavailable');
    }
  }

  let signet: readonly { address: string; handle: string }[] = [];
  try {
    signet = await (deps.findSignetContracts ?? defaultSignetContracts)(unique, network);
  } catch (error) {
    logger.warn({ network, error }, 'callee labels: Contract rows unavailable');
  }
  const handles = new Map(signet.map((r) => [r.address, r.handle]));

  const labels = new Map<string, CalleeLabel>();
  for (const address of unique) {
    const identity = identities.get(address);
    const expert = stellarExpertContractUrl(address, explorer);
    if (identity?.asset) {
      const text = identity.issuer
        ? `${identity.asset} (asset contract, issuer G…${identity.issuer.slice(-4)})`
        : `${identity.asset} (native asset contract)`;
      labels.set(address, { kind: 'asset', address, text, href: expert });
      continue;
    }
    const handle = handles.get(address);
    if (handle) {
      labels.set(address, {
        kind: 'signet',
        address,
        handle,
        text: `deployed by @${handle}`,
        href: `/p/${encodeURIComponent(handle)}/contract/${address}`,
      });
      continue;
    }
    labels.set(address, { kind: 'address', address, text: shortAddress(address), href: expert });
  }
  return labels;
}

// ── Mutability marks (#511) ────────────────────────────────────────────

/** How many of each function's latest invocations decide its mark. */
export const MUTABILITY_PER_FUNCTION = 50;

/** As long as the activity snapshot lives (apps/indexer/src/workers/activity.ts). */
export const MUTABILITY_TTL_MS = 5 * 60 * 1000;

/** What a Soroban RPC keeps: why marks only reach as far back as the index. */
export const RPC_RETENTION_NOTE =
  'Soroban RPC keeps about 7 days of transactions, so calls older than what Signet indexed are not seen.';

/**
 * The read/write overlay for a contract's diagram (design §4.2): one mark per
 * function of the current spec, from stored invocations, kept apart from the
 * spec-only layout because it changes on its own schedule. Plain data, so a
 * Server Component can hand it to the renderer.
 */
export interface MutabilityOverlay {
  readonly wasmHash: string | null;
  readonly marks: Readonly<Record<string, MutabilityMark>>;
  /** Invocations of the current code that decided marks. */
  readonly observations: number;
  readonly firstLedger: number | null;
  readonly lastLedger: number | null;
  /** Invocations of an earlier code version, ignored. */
  readonly staleObservations: number;
  /** Why every mark is unknown, when they all are for a reason. */
  readonly reason: string | null;
  readonly retentionNote: string;
}

/** A stored `ContractInvocation`, as much of it as a mark needs. */
export interface InvocationRow {
  readonly function: string | null;
  readonly txHash: string;
  readonly ledger: number;
  readonly successful: boolean;
  readonly wasmHash: string | null;
  readonly readOnly: unknown;
  readonly readWrite: unknown;
  readonly changed: unknown;
}

export interface MutabilityDeps {
  getContractSpec?: DiagramDeps['getContractSpec'];
  /** The latest `limit` invocations of `fn`; null when there is no database. */
  invocations?: (request: { address: string; network: string; fn: string; limit: number }) => Promise<InvocationRow[] | null>;
  now?: () => number;
}

const keys = (v: unknown): string[] => (Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []);

async function prismaInvocations(request: { address: string; network: string; fn: string; limit: number }): Promise<InvocationRow[] | null> {
  if (!process.env.DATABASE_URL) return null;
  const { prisma } = await import('@signet/db');
  return (prisma as any).contractInvocation.findMany({
    where: { function: request.fn, contract: { address: request.address, network: request.network } },
    orderBy: { ledger: 'desc' },
    take: request.limit,
    select: {
      function: true,
      txHash: true,
      ledger: true,
      successful: true,
      wasmHash: true,
      readOnly: true,
      readWrite: true,
      changed: true,
    },
  });
}

const mutabilityCache = new Map<string, { at: number; overlay: MutabilityOverlay }>();

export function __resetMutabilityCache(): void {
  mutabilityCache.clear();
}

function unknownFor(functions: readonly { name: string }[], wasmHash: string | null, reason: string): MutabilityOverlay {
  const marks: Record<string, MutabilityMark> = {};
  for (const fn of functions) {
    marks[fn.name] = { kind: 'unknown', staleObservations: 0, unversionedObservations: 0, seededObservations: 0 };
  }
  return { wasmHash, marks, observations: 0, firstLedger: null, lastLedger: null, staleObservations: 0, reason, retentionNote: RPC_RETENTION_NOTE };
}

/**
 * Reads a contract's stored invocations (#417), the latest
 * `MUTABILITY_PER_FUNCTION` per function, normalises their keys (#509) and
 * classifies them against the current spec. Cached for five minutes. With
 * no database every mark is unknown, with the reason: the web app never
 * simulates on a visitor's behalf (#521).
 */
export async function getMutabilityOverlay(
  address: string,
  network: string,
  deps: MutabilityDeps = {},
): Promise<MutabilityOverlay | null> {
  const now = deps.now ?? Date.now;
  try {
    const resolveSpec = deps.getContractSpec ?? loadContractSpec;
    const specResult = await resolveSpec({ address, network, wasmHash: null });
    if (!specResult.ok) return null;
    const spec = fromSpecJson(specResult.spec);
    const key = `${network}:${address}:${spec.wasmHash}`;
    const hit = mutabilityCache.get(key);
    if (hit && now() - hit.at < MUTABILITY_TTL_MS) return hit.overlay;

    const read = deps.invocations ?? prismaInvocations;
    const observations: FootprintObservation[] = [];
    for (const fn of spec.functions) {
      const rows = await read({ address, network, fn: fn.name, limit: MUTABILITY_PER_FUNCTION });
      if (rows === null) {
        const overlay = unknownFor(spec.functions, spec.wasmHash, 'No indexed observations in this environment.');
        mutabilityCache.set(key, { at: now(), overlay });
        return overlay;
      }
      for (const row of rows) {
        observations.push(
          normaliseFootprint({
            contract: address,
            function: row.function,
            source: 'transaction',
            ledger: row.ledger,
            txHash: row.txHash,
            wasmHash: row.wasmHash,
            readOnly: keys(row.readOnly),
            readWrite: keys(row.readWrite),
            changed: row.changed === null || row.changed === undefined ? null : keys(row.changed),
            successful: row.successful,
          }),
        );
      }
    }
    const classified = classifyFunctions(spec, observations);
    const marks: Record<string, MutabilityMark> = {};
    for (const [name, mark] of classified) marks[name] = mark;
    const current = observations.filter((o) => o.wasmHash === spec.wasmHash);
    const ledgers = current.map((o) => o.ledger);
    const overlay: MutabilityOverlay = {
      wasmHash: spec.wasmHash,
      marks,
      observations: current.length,
      firstLedger: ledgers.length ? Math.min(...ledgers) : null,
      lastLedger: ledgers.length ? Math.max(...ledgers) : null,
      staleObservations: observations.filter((o) => o.wasmHash && o.wasmHash !== spec.wasmHash).length,
      reason: observations.length === 0 ? 'No calls to this contract have been indexed yet.' : null,
      retentionNote: RPC_RETENTION_NOTE,
    };
    mutabilityCache.set(key, { at: now(), overlay });
    return overlay;
  } catch (error) {
    logger.warn({ address, network, error }, 'failed to compute mutability marks');
    return null;
  }
}
