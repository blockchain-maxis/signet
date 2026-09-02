import type { WalletSource } from '@signet/types';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { seedProfiles } from '../seed-data.js';

/**
 * Minimal slice of the Prisma client this worker touches. Declaring it as an
 * interface lets tests inject a lightweight mock instead of a real database.
 */
export interface SeedStore {
  profile: {
    upsert(args: {
      where: { handle: string };
      update: { displayName: string; bio: string };
      create: { handle: string; displayName: string; bio: string };
    }): Promise<{ id: string }>;
  };
  wallet: {
    upsert(args: {
      where: { pubkey: string };
      update: { profileId: string };
      create: { pubkey: string; profileId: string; source: WalletSource; isPrimary: boolean };
    }): Promise<unknown>;
  };
}

/**
 * Seed (or reseed) the curated demo profiles. Every write is an upsert keyed
 * on the profile handle / wallet pubkey, so running this any number of times
 * converges on the same state instead of accumulating duplicates.
 */
export async function seed(store: SeedStore): Promise<void> {
  logger.info({}, 'seed.start');

  for (const profile of seedProfiles) {
    const dbProfile = await store.profile.upsert({
      where:  { handle: profile.handle },
      update: { displayName: profile.displayName, bio: profile.bio },
      create: { handle: profile.handle, displayName: profile.displayName, bio: profile.bio },
    });

    for (const pubkey of profile.wallets) {
      if (pubkey === 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') {
        logger.warn({ pubkey }, 'seed.skippingPlaceholder — replace with a real wallet pubkey before demo');
        continue;
      }

      await store.wallet.upsert({
        where:  { pubkey },
        update: { profileId: dbProfile.id },
        create: { pubkey, profileId: dbProfile.id, source: 'curated', isPrimary: true },
      });

      logger.info({ handle: profile.handle, pubkey }, 'seed.walletUpserted');
    }

    logger.info({ handle: profile.handle }, 'seed.profileUpserted');
  }

  logger.info({ count: seedProfiles.length }, 'seed.complete');
}

export async function runSeedWorker(): Promise<void> {
  await seed(prisma as unknown as SeedStore);
}
