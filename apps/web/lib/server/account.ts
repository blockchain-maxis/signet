/**
 * Authenticated-account data layer for the dashboard.
 *
 * Maps a signed-in wallet (the `G…` address proven via Sign-In With Stellar) to
 * its on-chain-bound profile and lets the owner edit the *presentation* fields
 * (display name, bio). The handle and wallet bindings themselves are governed
 * on-chain by the Identity Registry — they are never mutated here.
 *
 * The Prisma client is imported lazily so the web app keeps working without a
 * database (the public `/p` routes don't need one); edits, however, require a
 * configured DB and a profile that already exists from an on-chain claim.
 *
 * Because the registry — not Postgres — is authoritative for the handle→wallet
 * binding, the handle is resolved from the registry whenever the database
 * can't answer: no `DATABASE_URL`, or a claim the indexer hasn't synced yet.
 */

import { isWalletSource, type WalletSource } from '@signet/types';
import { logger } from '../logger.ts';
import { lookupWallet, type RegistryReadOptions } from './registry-read.ts';

export interface Account {
  address: string;
  handle: string | null;
  displayName: string | null;
  bio: string | null;
  dbConfigured: boolean;
  /**
   * Whether the presentation fields can be edited — true only once a profile
   * row exists for this wallet. A handle resolved straight from the registry
   * is real but not yet editable: `displayName`/`bio` live in Postgres, so
   * `updateAccount` has nothing to write to until the indexer syncs the claim.
   */
  editable: boolean;
}

export interface AccountUpdate {
  displayName: string | null;
  bio: string | null;
}

export interface LinkedWallet {
  pubkey: string;
  isPrimary: boolean;
  /** 'onchain' once attested via the Identity Registry, else 'curated' or 'cli'. */
  source: WalletSource;
  attestedAt: string;
}

const MAX_DISPLAY_NAME = 80;
const MAX_BIO = 280;

/** Fallback used when a stored `source` value isn't one of the allowed ones. */
const FALLBACK_WALLET_SOURCE: WalletSource = 'curated';

function toWalletSource(value: string, pubkey: string): WalletSource {
  if (isWalletSource(value)) return value;
  logger.warn({ pubkey, source: value }, 'account.unknownWalletSource');
  return FALLBACK_WALLET_SOURCE;
}

async function getPrisma() {
  if (!process.env.DATABASE_URL) return null;
  const { prisma } = await import('@signet/db');
  return prisma;
}

/**
 * Resolve the signed-in wallet's account; profile fields are null until claimed.
 *
 * The presentation fields (display name, bio) live only in the database, so
 * they stay null without one. The handle does not: it falls back to an
 * on-chain `lookup` against the Identity Registry, which is what makes a
 * just-claimed handle show up on the dashboard immediately — without a
 * database at all, and ahead of the indexer on deployments that have one.
 * That read is soft-failing, so an unconfigured or unreachable registry
 * simply leaves the handle null rather than breaking the dashboard.
 */
export async function getAccount(
  address: string,
  options: RegistryReadOptions = {},
): Promise<Account> {
  const prisma = await getPrisma();
  if (!prisma) {
    return {
      address,
      handle: await lookupWallet(address, options),
      displayName: null,
      bio: null,
      dbConfigured: false,
      editable: false,
    };
  }

  const wallet = await prisma.wallet.findUnique({
    where: { pubkey: address },
    include: { profile: true },
  });
  const profile = wallet?.profile;
  return {
    address,
    handle: profile?.handle ?? (await lookupWallet(address, options)),
    displayName: profile?.displayName ?? null,
    bio: profile?.bio ?? null,
    dbConfigured: true,
    editable: profile != null,
  };
}

/** All wallets bound to the signed-in account's profile (primary first). */
export async function getAccountWallets(address: string): Promise<LinkedWallet[]> {
  const prisma = await getPrisma();
  if (!prisma) return [];
  const self = await prisma.wallet.findUnique({
    where: { pubkey: address },
    select: { profileId: true },
  });
  if (!self) return [];
  const wallets = await prisma.wallet.findMany({
    where: { profileId: self.profileId },
    orderBy: [{ isPrimary: 'desc' }, { attestedAt: 'asc' }],
  });
  return wallets.map((w) => ({
    pubkey: w.pubkey,
    isPrimary: w.isPrimary,
    // The database column is an untyped String; validate on read rather than
    // trust it, so a row written outside this codebase can't smuggle an
    // unknown provenance value into the UI.
    source: toWalletSource(w.source, w.pubkey),
    attestedAt: w.attestedAt.toISOString().slice(0, 10),
  }));
}

/**
 * Trim + length-bound the editable fields. Throws on anything too long so the
 * caller surfaces a 4xx rather than silently truncating.
 */
export function normalizeAccountUpdate(raw: unknown): AccountUpdate {
  const obj = (raw ?? {}) as { displayName?: unknown; bio?: unknown };
  const clean = (v: unknown, max: number, field: string): string | null => {
    if (v == null) return null;
    const s = String(v).trim();
    if (s.length === 0) return null;
    if (s.length > max) throw new Error(`${field} must be ${max} characters or fewer`);
    return s;
  };
  return {
    displayName: clean(obj.displayName, MAX_DISPLAY_NAME, 'Display name'),
    bio: clean(obj.bio, MAX_BIO, 'Bio'),
  };
}

/** Update the signed-in wallet's profile presentation fields. */
export async function updateAccount(address: string, update: AccountUpdate): Promise<Account> {
  const prisma = await getPrisma();
  if (!prisma) {
    throw new Error('Profile editing requires a configured database');
  }
  const wallet = await prisma.wallet.findUnique({
    where: { pubkey: address },
    select: { profileId: true },
  });
  if (!wallet) {
    throw new Error('No profile is bound to this wallet yet — claim a handle on-chain first');
  }
  const profile = await prisma.profile.update({
    where: { id: wallet.profileId },
    data: { displayName: update.displayName, bio: update.bio },
  });
  return {
    address,
    handle: profile.handle,
    displayName: profile.displayName,
    bio: profile.bio,
    dbConfigured: true,
    editable: true,
  };
}
