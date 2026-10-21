import { ok, withV1 } from '../../../../../lib/api/v1/http.ts';
import { getRegistryStats, type RegistryStatsOptions } from '../../../../../lib/registry-stats.ts';

export const runtime = 'nodejs';

/**
 * GET /api/v1/registry/stats (#646)
 *
 * Public counts for dashboards and ecosystem reports.
 * Returns { network, registryContract, boundHandles, indexedWallets, indexedContracts }.
 * Any count the deployment cannot compute is null, never 0.
 * Cache: public, s-maxage=300.
 */
export async function v1RegistryStatsData(options: RegistryStatsOptions = {}) {
  return getRegistryStats(options);
}

function handle(req: Request): Promise<Response> {
  return withV1(async () => ok(await v1RegistryStatsData()), {
    cache: 'public, s-maxage=300',
  })(req);
}

export const GET = handle;
export const OPTIONS = handle;
