import { NextResponse } from 'next/server';
import { collectHealth } from '@/lib/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness/readiness probe for load balancers and uptime monitors.
 *
 * Always reports the service as live, and reports each configured dependency
 * — Postgres, the on-chain Identity Registry, the shared nonce and rate-limit
 * stores, and whether pairing (wallet↔handle binding, which needs both the
 * registry and the database) is operational — as its own check. A
 * dependency that is down degrades to `status: "degraded"` with HTTP 200
 * rather than failing the whole probe, since the static `/p` profiles serve
 * without either one. See `lib/health.ts` for the probe semantics.
 */
export async function GET() {
  const report = await collectHealth();
  return NextResponse.json(report, { headers: { 'cache-control': 'no-store' } });
}
