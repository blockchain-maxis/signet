import { ok, withV1 } from '../../../../lib/api/v1/http.ts';
import { collectHealth, type HealthProbes } from '../../../../lib/health.ts';
import { getConfiguredNetwork } from '../../../../lib/cli-link.ts';
import { getNetworkPassphrase } from '../../../../lib/sep10.ts';

export const runtime = 'nodejs';

/**
 * GET /api/v1/health (#627)
 *
 * The stable v1 face of the operator probe: everything `/api/health` reports
 * (via the same `collectHealth()`, `pairing` check included), plus what an
 * integrator or the CLI (`signet status`, `signet doctor`) needs to know about
 * *which* deployment answered — `apiVersion`, the configured `network` and its
 * `networkPassphrase`. Degraded still answers HTTP 200 with
 * `status: "degraded"`, matching `/api/health`'s semantics: the static
 * surfaces serve through a dependency outage, and a load balancer must not
 * pull the instance. Never cached; rate-limited as an ordinary v1 read.
 */
export async function v1HealthData(probes: HealthProbes = {}) {
  const report = await collectHealth(probes);
  return {
    status: report.status,
    apiVersion: '1' as const,
    network: getConfiguredNetwork(),
    networkPassphrase: getNetworkPassphrase(),
    checks: report.checks,
  };
}

function handle(req: Request): Promise<Response> {
  return withV1(async () => ok(await v1HealthData()), { cache: 'no-store' })(req);
}

export const GET = handle;
export const OPTIONS = handle;
