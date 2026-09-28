/**
 * Contract attribution (C-02, #444): did one of this handle's wallets deploy
 * this contract?
 *
 * This is the rule the whole contract page rests on. `/p/{handle}/contract/{address}`
 * renders only when attribution succeeds; anything else is a 404 (or the error
 * state from #459 when the lookup itself was unavailable).
 *
 * Two layers, mirroring `getProfile` in `./profiles.ts`:
 *
 * 1. **Database.** A `Contract` row with `address = {address}`, whose
 *    `wallet.profile.handle = {handle}` (any of the handle's wallets, not just
 *    the primary one), and whose `network` equals the configured
 *    `STELLAR_NETWORK`. The database answers authoritatively when it is
 *    reachable: a reachable DB with no matching row means `not-attributed` and
 *    does NOT fall through to Horizon, so a DB outage and a real miss behave
 *    differently.
 * 2. **Horizon, only when there is no database** (`DATABASE_URL` unset or the
 *    DB unreachable). The handle's wallets are resolved and each `G…` wallet's
 *    Horizon operations are walked for `invoke_host_function` records whose
 *    `function` is `HostFunctionTypeCreateContract` — the same filter the
 *    indexer's deployment worker uses. For each record the created contract ID
 *    is derived with `deriveContractId` from its `address`/`salt` fields; when
 *    those fields are missing the transaction is fetched and the return value
 *    is decoded from result meta, handling both `TransactionMeta` v3 and v4
 *    (the same approach as the indexer's `extractContractAddress`, fixed for
 *    v4 in #410). The walk stops at `HORIZON_MAX_RECORDS`.
 *
 * Known limitations, by design in this version:
 *
 * - Contracts deployed through a **factory contract** (the wallet invoked a
 *   factory that created the contract) are not attributed. See also #668.
 * - Contract-controlled identities (`C…` wallets) are covered **only through
 *   the DB**: the Horizon path walks `G…` wallets alone, because
 *   `fetchHorizonOperations` refuses `C…` wallets.
 */
import { cache } from 'react';
import { isValidHandle, networkPassphrase, type Network } from '@signet/types';
import { STELLAR_NETWORK } from './chain.ts';
import { deriveContractId, isContractAddress } from './contract-address.ts';
import { getProfile } from './profiles.ts';
import { HORIZON_MAX_RECORDS } from './server/horizon.ts';
import { xdr, StrKey } from '@stellar/stellar-sdk';

/** A contract attributed to a handle, ready to render. */
export interface AttributedContract {
  address: string;
  network: string;
  deployerPubkey: string;
  deployTxHash: string;
  /** ISO-8601 timestamp of the deployment. */
  deployedAt: string;
  /** Indexed WASM hash from the DB, null on the Horizon path. */
  wasmHash: string | null;
  /** Database wallet row that owns the contract; absent on the Horizon path. */
  walletId?: string;
}

/**
 * The attribution verdict. `not-attributed` and `invalid` both render as 404;
 * `unavailable` renders the error state from #459. `capped` says the Horizon
 * walk hit its record cap without a match, so the miss is a lower bound.
 */
export type Attribution =
  | { status: 'attributed'; source: 'database' | 'horizon'; contract: AttributedContract }
  | { status: 'not-attributed'; capped?: boolean }
  | { status: 'invalid' }
  | { status: 'unavailable' };

/** Minimal `Contract` row projection the attribution query needs. */
export interface AttributionDbRow {
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
 * Database seam. `findContract` returns the row when the address is owned by
 * one of the handle's wallets on the given network, `null` when the database
 * is reachable but holds no such row (authoritative miss), and `undefined`
 * when there is no database at all (`DATABASE_URL` unset or unreachable).
 */
export interface AttributionDb {
  findContract: (args: {
    address: string;
    handle: string;
    network: string;
  }) => Promise<AttributionDbRow | null | undefined>;
}

/** Minimal Horizon operation shape the attribution walk needs. */
export interface AttributionHorizonOp {
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
 * Horizon seam, following the store/seam pattern of the indexer's
 * `DeploymentStore`: tests inject fakes, so no test needs the network.
 */
export interface AttributionHorizon {
  /** Wallets bound to the handle, in preference order. */
  listWallets: (handle: string) => Promise<string[]>;
  /**
   * Operations for one wallet. Returns `null` when the wallet has no readable
   * history (e.g. unfunded account); throws on transport failure, which
   * surfaces as `unavailable`.
   */
  listOperations: (
    wallet: string,
  ) => Promise<{ operations: AttributionHorizonOp[]; truncated: boolean } | null>;
  /**
   * Base64 `result_meta_xdr` for a transaction, or `null` when the transaction
   * has none to offer. Throws on transport failure.
   */
  getResultMetaXdr: (txHash: string) => Promise<string | null>;
}

export interface AttributeContractDeps {
  /** Canonical network the contract must belong to. Defaults to `STELLAR_NETWORK`. */
  network?: Network;
  /** Database seam. Defaults to the Prisma-backed lookup, gated on `DATABASE_URL`. */
  db?: AttributionDb;
  /** Horizon seam. Defaults to live Horizon fetchers. */
  horizon?: AttributionHorizon;
}

const CREATE_CONTRACT_FUNCTION = 'HostFunctionTypeCreateContract';

const defaultDb: AttributionDb = {
  findContract: async ({ address, handle, network }) => {
    if (!process.env.DATABASE_URL) return undefined;
    try {
      const { prisma } = await import('@signet/db');
      const row = await prisma.contract.findFirst({
        where: {
          address,
          network,
          wallet: { profile: { handle: handle.toLowerCase() } },
        },
        include: { wallet: { select: { id: true, pubkey: true } } },
      });
      if (!row) return null;
      return {
        address: row.address,
        network: row.network,
        deployerPubkey: row.deployerPubkey,
        deployTxHash: row.deployTxHash,
        deployedAt: row.deployedAt,
        wasmHash: row.wasmHash,
        walletId: row.walletId,
        walletPubkey: row.wallet.pubkey,
      };
    } catch {
      return undefined;
    }
  },
};

const defaultHorizon: AttributionHorizon = {
  listWallets: async (handle: string) => {
    const profile = await getProfile(handle);
    return profile?.wallet ? [profile.wallet] : [];
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

export type ExtractContractReason =
  | 'not-soroban'
  | 'no-return-value'
  | 'not-contract-address'
  | 'unsupported-meta-version'
  | 'decode-error';

export type DecodeContractResult =
  | { ok: true; address: string; metaVersion: number }
  | { ok: false; reason: ExtractContractReason; metaVersion?: number };

/**
 * Decode a deployed contract address from a transaction's base64
 * `result_meta_xdr`, handling both `TransactionMeta` v3 and v4 — the same
 * approach as the indexer's `extractContractAddress` (v4 support added in
 * #410). Exported so the v3/v4 parity is directly testable.
 */
export function decodeContractAddressFromMeta(resultMetaXdr: string): DecodeContractResult {
  let meta: xdr.TransactionMeta;
  try {
    meta = xdr.TransactionMeta.fromXDR(resultMetaXdr, 'base64');
  } catch {
    return { ok: false, reason: 'decode-error' };
  }

  const switchVal = meta.switch();
  let returnVal: xdr.ScVal | null = null;
  let metaVersion: number;

  switch (switchVal) {
    case 3: {
      metaVersion = 3;
      const sorobanMeta = meta.v3().sorobanMeta();
      if (!sorobanMeta) return { ok: false, reason: 'not-soroban', metaVersion };
      returnVal = sorobanMeta.returnValue();
      break;
    }
    case 4: {
      metaVersion = 4;
      const sorobanMeta = meta.v4().sorobanMeta();
      if (!sorobanMeta) return { ok: false, reason: 'not-soroban', metaVersion };
      returnVal = sorobanMeta.returnValue();
      break;
    }
    default:
      return {
        ok: false,
        reason: 'unsupported-meta-version',
        metaVersion: typeof switchVal === 'number' ? switchVal : undefined,
      };
  }

  if (!returnVal) return { ok: false, reason: 'no-return-value', metaVersion };

  try {
    if (returnVal.switch().name !== 'scvAddress') {
      return { ok: false, reason: 'not-contract-address', metaVersion };
    }
    const addr = returnVal.address();
    if (addr.switch().name !== 'scAddressTypeContract') {
      return { ok: false, reason: 'not-contract-address', metaVersion };
    }
    const contractId = addr.contractId();
    const address = StrKey.encodeContract(Buffer.from(contractId as unknown as Uint8Array));
    return { ok: true, address, metaVersion };
  } catch {
    return { ok: false, reason: 'decode-error', metaVersion };
  }
}

function toAttributedContract(row: AttributionDbRow, network: string): AttributedContract {
  return {
    address: row.address,
    network,
    deployerPubkey: row.deployerPubkey,
    deployTxHash: row.deployTxHash,
    deployedAt: row.deployedAt instanceof Date ? row.deployedAt.toISOString() : row.deployedAt,
    wasmHash: row.wasmHash,
    walletId: row.walletId,
  };
}

/**
 * Derive the created contract ID for one create-contract operation: from the
 * record's `address`/`salt` fields when present, else by fetching the
 * transaction and decoding its result meta. Returns null when neither path
 * yields an address. A failed decode is an ordinary miss, not an outage.
 */
async function deriveCreatedAddress(
  op: AttributionHorizonOp,
  deployer: string,
  passphrase: string,
  horizon: AttributionHorizon,
): Promise<string | null> {
  // Prefer the record's own inputs; the walked wallet is the fallback
  // deployer for records that carry a salt but no address.
  const fromAddress = op.address ?? deployer;
  if (op.salt) {
    try {
      return deriveContractId({ deployer: fromAddress, salt: op.salt, networkPassphrase: passphrase });
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

async function attributeFromHorizon(
  handle: string,
  address: string,
  network: Network,
  horizon: AttributionHorizon,
): Promise<Attribution> {
  const passphrase = networkPassphrase(network);
  const wallets = await horizon.listWallets(handle);
  // Contract-controlled identities are covered only through the DB (see the
  // module doc): the Horizon walk is G… wallets alone.
  const gWallets = wallets.filter((w) => w.startsWith('G'));

  let scanned = 0;
  let capped = false;
  for (const wallet of gWallets) {
    const page = await horizon.listOperations(wallet);
    if (!page) continue;
    for (const op of page.operations) {
      if (scanned >= HORIZON_MAX_RECORDS) {
        capped = true;
        break;
      }
      scanned += 1;
      if (op.type !== 'invoke_host_function' || op.function !== CREATE_CONTRACT_FUNCTION) {
        continue;
      }
      const created = await deriveCreatedAddress(op, wallet, passphrase, horizon);
      if (created === address) {
        return {
          status: 'attributed',
          source: 'horizon',
          contract: {
            address,
            network,
            deployerPubkey: wallet,
            deployTxHash: op.transactionHash ?? '',
            deployedAt: op.createdAt,
            wasmHash: null,
          },
        };
      }
    }
    if (capped) break;
    if (page.truncated) capped = true;
  }
  return capped ? { status: 'not-attributed', capped: true } : { status: 'not-attributed' };
}

/**
 * Attribution with injectable seams — the entry point tests use, so no test
 * needs a database or the network.
 */
export async function attributeContractWithDeps(
  handle: string,
  address: string,
  deps: AttributeContractDeps = {},
): Promise<Attribution> {
  // Validate before any I/O: malformed input must not touch the DB or Horizon.
  if (!isValidHandle(handle) || !isContractAddress(address)) return { status: 'invalid' };

  const network = deps.network ?? STELLAR_NETWORK;
  const db = deps.db ?? defaultDb;

  let dbRow: AttributionDbRow | null | undefined;
  try {
    dbRow = await db.findContract({ address, handle, network });
  } catch {
    dbRow = undefined;
  }
  // The database is authoritative when reachable: a real miss stays a miss.
  if (dbRow) return { status: 'attributed', source: 'database', contract: toAttributedContract(dbRow, network) };
  if (dbRow === null) return { status: 'not-attributed' };

  // No database (unset DATABASE_URL or unreachable): fall back to Horizon.
  const horizon = deps.horizon ?? defaultHorizon;
  try {
    return await attributeFromHorizon(handle, address, network, horizon);
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * Cached attribution for the contract page: the layout, `generateMetadata`
 * and the OG image share one lookup per request (#458 builds on this).
 */
export const attributeContract = cache(
  (handle: string, address: string): Promise<Attribution> =>
    attributeContractWithDeps(handle, address),
);
