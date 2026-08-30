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
  /** 'onchain' once attested via the Identity Registry, else 'curated'. */
  source: string;
  attestedAt: string;
}

const MAX_DISPLAY_NAME = 80;
const MAX_BIO = 280;

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
    source: w.source,
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

/**
 * `pubkey` is already bound to a different profile than the one being linked
 * to. `Wallet.pubkey` is `@unique`, so a deploy wallet can only ever belong
 * to one profile — this is the caller's mistake (or someone else's wallet),
 * not a transient failure.
 */
export class WalletAlreadyLinkedError extends Error {
  readonly pubkey: string;

  constructor(pubkey: string) {
    super(`Wallet ${pubkey} is already linked to a different profile`);
    this.name = 'WalletAlreadyLinkedError';
    this.pubkey = pubkey;
  }
}

/** True for a Prisma unique-constraint violation (error code P2002). */
function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

function toLinkedWallet(wallet: { pubkey: string; isPrimary: boolean; source: string; attestedAt: Date }): LinkedWallet {
  return {
    pubkey: wallet.pubkey,
    isPrimary: wallet.isPrimary,
    source: wallet.source,
    attestedAt: wallet.attestedAt.toISOString().slice(0, 10),
  };
}

/**
 * The persistence surface `linkDeployWallet` needs — mirrors the injectable-
 * store pattern the indexer workers use (e.g. `DeploymentStore` in
 * `apps/indexer/src/workers/deployment.ts`), for the same reason: it's what
 * lets the idempotent-re-link and typed-conflict paths be tested without a
 * real database.
 */
export interface LinkWalletStore {
  wallet: {
    findUnique(args: {
      where: { pubkey: string };
    }): Promise<{ pubkey: string; profileId: string; isPrimary: boolean; source: string; attestedAt: Date } | null>;
    create(args: {
      data: { pubkey: string; profileId: string; source: string; isPrimary: boolean; attestedAt: Date };
    }): Promise<{ pubkey: string; isPrimary: boolean; source: string; attestedAt: Date }>;
    update(args: {
      where: { pubkey: string };
      data: { attestedAt: Date; source: string };
    }): Promise<{ pubkey: string; isPrimary: boolean; source: string; attestedAt: Date }>;
  };
}

/**
 * Attach a deploy wallet to a profile — the writer `getAccountWallets`'s read
 * path has been waiting on. Never touches `isPrimary`: that binding is the
 * handle's own on-chain claim, changed only via the Identity Registry
 * (release/transfer), never by linking an additional wallet here.
 *
 * Idempotent: re-linking the same `pubkey` to the same `profileId` updates
 * `attestedAt`/`source` on the existing row rather than duplicating it.
 * Linking a `pubkey` already bound to a *different* profile throws
 * `WalletAlreadyLinkedError` instead — checked up front, and re-checked if a
 * concurrent write wins the race between that check and the insert, since
 * `Wallet.pubkey`'s uniqueness is what both properties (idempotent / typed
 * conflict) ultimately rest on.
 */
export async function linkDeployWallet(
  profileId: string,
  pubkey: string,
  source: string,
  store?: LinkWalletStore,
): Promise<LinkedWallet> {
  const db = store ?? ((await getPrisma()) as unknown as LinkWalletStore | null);
  if (!db) {
    throw new Error('Linking a wallet requires a configured database');
  }

  const existing = await db.wallet.findUnique({ where: { pubkey } });
  if (existing) {
    if (existing.profileId !== profileId) {
      throw new WalletAlreadyLinkedError(pubkey);
    }
    const updated = await db.wallet.update({
      where: { pubkey },
      data: { attestedAt: new Date(), source },
    });
    return toLinkedWallet(updated);
  }

  try {
    const created = await db.wallet.create({
      data: { pubkey, profileId, source, isPrimary: false, attestedAt: new Date() },
    });
    return toLinkedWallet(created);
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;

    // Lost a race: another write linked this pubkey between the check above
    // and this create. Re-read once to resolve it the same way the
    // up-front check would have.
    const raced = await db.wallet.findUnique({ where: { pubkey } });
    if (!raced) throw err; // deleted again in between — vanishingly unlikely; surface the original error
    if (raced.profileId !== profileId) {
      throw new WalletAlreadyLinkedError(pubkey);
    }
    const updated = await db.wallet.update({
      where: { pubkey },
      data: { attestedAt: new Date(), source },
    });
    return toLinkedWallet(updated);
  }
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
