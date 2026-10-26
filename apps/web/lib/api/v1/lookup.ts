/**
 * `GET /api/v1/lookup/{address}` (#645): which handle, if any, a wallet is
 * attributed to on this deployment. The reverse of resolve.
 *
 * The database's `Wallet` row answers first, whatever its source, so a
 * wallet linked from the terminal (`source: "cli"`) or curated is found, not
 * only the on-chain primary binding. With no row, or no database, the
 * Identity Registry's `lookup` answers: a hit there is the handle's on-chain
 * primary wallet.
 *
 * An address linked to nothing is a 200 with `handle: null`, not a 404: the
 * address is valid, it is just not linked. But "not linked" is only said when
 * a layer could say it: with no database row and a registry that could not
 * be read, the answer is a 503, never a `null` that reads as "not linked".
 */
import type { WalletLookup } from '@signet/types';
import { getConfiguredNetwork } from '../../cli-link.ts';
import { logger } from '../../logger.ts';
import { lookupWalletDetailed, type WalletLookupResult } from '../../server/registry-read.ts';
import { toWalletSource } from '../../server/account.ts';
import { ok, V1Error, withV1 } from './http.ts';
import { C_ADDRESS, G_ADDRESS } from '../../stellar-address.ts';

export const LOOKUP_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300';

/** The `Wallet` row the lookup reads. */
export interface LookupWalletRow {
  isPrimary: boolean;
  source: string;
  profile: { handle: string };
}

export interface LookupDeps {
  /**
   * The wallet's row, null when the database has none, undefined when there
   * is no database (or it is unreachable).
   */
  findWallet?: (address: string) => Promise<LookupWalletRow | null | undefined>;
  lookupWallet?: (address: string) => Promise<WalletLookupResult>;
  network?: string;
}

export interface V1LookupMeta {
  /** 'database' when a Wallet row answered, else 'chain' (the registry). */
  source: 'database' | 'chain';
}

async function prismaFindWallet(address: string): Promise<LookupWalletRow | null | undefined> {
  if (!process.env.DATABASE_URL) return undefined;
  const { prisma } = await import('@signet/db');
  return prisma.wallet.findUnique({
    where: { pubkey: address },
    select: { isPrimary: true, source: true, profile: { select: { handle: true } } },
  });
}

/** Validates the path's address: a G… account, with C… pointed elsewhere. */
export function parseLookupAddress(raw: unknown): string {
  const address = String(raw ?? '').trim();
  if (C_ADDRESS.test(address)) {
    throw new V1Error(
      'bad_request',
      'Lookup takes a G… account address. For a C… contract, use /api/v1/contracts/{address}/spec, or /api/v1/profiles/{handle}/contracts/{address} to check who deployed it.',
      { parameter: 'address' },
    );
  }
  if (!G_ADDRESS.test(address)) {
    throw new V1Error('bad_request', `Invalid G… account address "${address}".`, {
      parameter: 'address',
    });
  }
  return address;
}

export async function getV1Lookup(
  address: string,
  deps: LookupDeps = {},
): Promise<{ data: WalletLookup; meta: V1LookupMeta }> {
  const network = deps.network ?? getConfiguredNetwork();
  let row: LookupWalletRow | null | undefined;
  try {
    row = await (deps.findWallet ?? prismaFindWallet)(address);
  } catch (err) {
    // A database outage is not an answer: ask the registry instead.
    logger.warn({ err, address }, 'api.v1.lookup.dbUnavailable');
    row = undefined;
  }
  if (row) {
    return {
      data: {
        address,
        handle: row.profile.handle,
        source: toWalletSource(row.source, address),
        isPrimary: row.isPrimary,
        network,
      },
      meta: { source: 'database' },
    };
  }
  const chain = await (deps.lookupWallet ?? lookupWalletDetailed)(address);
  const unlinked = (source: V1LookupMeta['source']) => ({
    data: { address, handle: null, source: null, isPrimary: false, network },
    meta: { source },
  });
  switch (chain.status) {
    case 'bound':
      // The registry binds a handle to its primary wallet only.
      return {
        data: { address, handle: chain.handle, source: 'onchain', isPrimary: true, network },
        meta: { source: 'chain' },
      };
    case 'unbound':
      return unlinked('chain');
    case 'unconfigured':
      // No registry to ask: the database's miss is the whole answer.
      if (row === null) return unlinked('database');
      break;
  }
  throw new V1Error('unavailable', 'Could not look this address up. Try again later.');
}

type Ctx = { params: Promise<{ address: string }> };

/** The route's handler, with the lookups injectable for tests. */
export function lookupHandler(deps: LookupDeps = {}) {
  return (req: Request, ctx: Ctx): Promise<Response> =>
    withV1(
      async () => {
        const address = parseLookupAddress((await ctx.params).address);
        const { data, meta } = await getV1Lookup(address, deps);
        return ok(data, meta);
      },
      { cache: LOOKUP_CACHE_CONTROL },
    )(req);
}

/**
 * The headers `/api/cli/whoami` answers with, naming this route as its
 * successor; the address is a template when the request had none.
 */
export function whoamiDeprecation(publicKey: string | null): Record<string, string> {
  const successor = publicKey
    ? `/api/v1/lookup/${encodeURIComponent(publicKey)}`
    : '/api/v1/lookup/{address}';
  return { Deprecation: successor, Link: `<${successor}>; rel="successor-version"` };
}
