import { verifyChallenge, Sep10Error } from '../sep10.ts';
import { logger } from '../logger.ts';
import { spendChallenge } from './challenge-spend.ts';

/**
 * `signet unlink` — detach a deploy wallet from whichever profile holds it,
 * proving control of that wallet's key and nothing else.
 *
 * A link with no unlink is a one-way door (#261): a rotated or compromised
 * deploy key would keep feeding a profile with no way to stop it from the
 * terminal that owns the key.
 *
 * **Why key control alone is the right proof here, when attaching needs two.**
 * `pair/complete` requires the handle owner's browser session *and* a signed
 * challenge, because attaching a wallet makes a claim about somebody else's
 * profile. Detaching makes no claim: it withdraws one. The party who controls
 * the key is the party whose attestation the profile was displaying, and
 * letting them take it back is the whole point. Requiring the handle owner's
 * consent as well would mean a developer who left a team, or whose key was
 * compromised, could not stop that key feeding a profile they no longer
 * control — exactly the situation the issue describes.
 *
 * The reverse is also true and is why this is safe: removing a wallet can only
 * ever *reduce* what a profile claims. There is no version of this that
 * attributes work to someone.
 */

export type UnlinkFailure =
  | 'unavailable'
  | 'bad-challenge'
  | 'replayed'
  | 'not-linked'
  | 'primary-wallet';

export type UnlinkResult =
  | { ok: true; pubkey: string; handle: string | null }
  | { ok: false; reason: UnlinkFailure };

interface UnlinkRow {
  profileId: string;
  isPrimary: boolean;
}

/** The slice of Prisma this module touches, so tests can inject a fake. */
export interface UnlinkStore {
  wallet: {
    findUnique(args: {
      where: { pubkey: string };
      select: { profileId: true; isPrimary: true };
    }): Promise<UnlinkRow | null>;
    delete(args: { where: { pubkey: string } }): Promise<unknown>;
  };
  profile: {
    findUnique(args: { where: { id: string } }): Promise<{ handle: string } | null>;
  };
}

async function getStore(): Promise<UnlinkStore | null> {
  if (!process.env.DATABASE_URL) return null;
  const { prisma } = await import('@signet/db');
  return prisma as unknown as UnlinkStore;
}

/**
 * Verify a signed SEP-10 challenge and remove the wallet it proves control of.
 *
 * Ordering mirrors `completePairing`: verify first (free, and a failed attempt
 * must not spend anything), then consume the challenge, then write. Consuming
 * earlier would let anyone who merely saw the challenge — it is not secret —
 * burn it with a junk signature and lock the real caller out.
 */
export async function unlinkByChallenge(
  challengeXdr: string,
  store?: UnlinkStore,
): Promise<UnlinkResult> {
  const db = store ?? (await getStore());
  if (!db) return { ok: false, reason: 'unavailable' };

  let pubkey: string;
  try {
    pubkey = verifyChallenge(challengeXdr);
  } catch (err) {
    logger.warn(
      { error: err instanceof Sep10Error ? err.message : String(err) },
      'cliUnlink.badChallenge',
    );
    return { ok: false, reason: 'bad-challenge' };
  }

  if (!(await spendChallenge(challengeXdr))) {
    return fail(pubkey, 'replayed');
  }

  const wallet = await db.wallet.findUnique({
    where: { pubkey },
    select: { profileId: true, isPrimary: true },
  });
  if (!wallet) return fail(pubkey, 'not-linked');

  // The primary wallet is the handle→wallet claim itself, so releasing it is a
  // registry operation on-chain, not a row delete. Same refusal the dashboard
  // gives.
  if (wallet.isPrimary) return fail(pubkey, 'primary-wallet');

  const profile = await db.profile.findUnique({ where: { id: wallet.profileId } });
  await db.wallet.delete({ where: { pubkey } });
  logger.info({ pubkey, profileId: wallet.profileId }, 'cliUnlink.removed');

  return { ok: true, pubkey, handle: profile?.handle ?? null };
}

function fail(pubkey: string, reason: UnlinkFailure): UnlinkResult {
  logger.warn({ pubkey, reason }, 'cliUnlink.rejected');
  return { ok: false, reason };
}
