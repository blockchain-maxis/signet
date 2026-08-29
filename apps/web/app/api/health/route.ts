import { NextResponse } from 'next/server';
import { getNonceStoreStatus } from '@/lib/nonce-store';
import { getRateLimitStoreStatus } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness/readiness probe for load balancers and uptime monitors.
 *
 * Always reports the service as live. If `DATABASE_URL` is configured it also
 * runs a fast `SELECT 1` and reports the DB as a readiness check — but a DB
 * outage degrades to `status: "degraded"` with HTTP 200 rather than failing the
 * whole probe, since the static `/p` profiles serve without a database.
 */
async function checkDb(): Promise<'up' | 'down' | 'skipped'> {
  if (!process.env.DATABASE_URL) return 'skipped';
  try {
    const { prisma } = await import('@signet/db');
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
    return 'up';
  } catch {
    return 'down';
  }
}

export async function GET() {
  const [db, nonceStore, rateLimitStore] = await Promise.all([
    checkDb(),
    getNonceStoreStatus(),
    getRateLimitStoreStatus(),
  ]);

  // The nonce store fails closed — `down` means sign-in is refused for
  // everyone right now, a real outage. The rate limiter fails open, so its
  // `down` is a silent security degradation rather than an outage; it's
  // reported but doesn't flip the overall status.
  const status = db === 'down' || nonceStore === 'down' ? 'degraded' : 'ok';

  return NextResponse.json(
    {
      status,
      service: 'signet-web',
      ts: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      checks: { db, nonceStore, rateLimitStore },
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
