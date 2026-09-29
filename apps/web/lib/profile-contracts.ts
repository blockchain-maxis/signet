import { getConfiguredNetwork } from './cli-link.ts';
import { normalizeNetwork } from '@signet/types';

/**
 * Best-effort list of attributed contracts for the configured network.
 * Returns [] without a DB or if the query fails, like `safeDbHandles`.
 */
export async function listAttributedContracts(): Promise<
  { handle: string; address: string; deployedAt: Date }[]
> {
  if (!process.env.DATABASE_URL) return [];
  try {
    const { prisma } = await import('@signet/db');
    const network = normalizeNetwork(getConfiguredNetwork());

    const contracts = await prisma.contract.findMany({
      where: { network },
      select: {
        address: true,
        deployedAt: true,
        wallet: {
          select: {
            profile: {
              select: {
                handle: true,
              },
            },
          },
        },
      },
    });

    return contracts.map((c) => ({
      handle: c.wallet.profile.handle,
      address: c.address,
      deployedAt: c.deployedAt,
    }));
  } catch {
    return [];
  }
}
