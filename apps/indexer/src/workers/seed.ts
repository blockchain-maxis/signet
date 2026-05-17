import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { seedProfiles } from '../seed-data.js';

export async function runSeedWorker(): Promise<void> {
  logger.info({}, 'seed.start');

  for (const profile of seedProfiles) {
    const dbProfile = await prisma.profile.upsert({
      where:  { handle: profile.handle },
      update: { displayName: profile.displayName, bio: profile.bio },
      create: { handle: profile.handle, displayName: profile.displayName, bio: profile.bio },
    });

    for (const pubkey of profile.wallets) {
      if (pubkey === 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') {
        logger.warn({ pubkey }, 'seed.skippingPlaceholder — replace with a real wallet pubkey before demo');
        continue;
      }

      await prisma.wallet.upsert({
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
