import { NextResponse } from 'next/server';
import { MAX_REPORTS_PER_REQUEST, parseCspReports } from '@/lib/csp-report';
import { logger } from '@/lib/logger';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Collector for Content-Security-Policy violation reports.
 *
 * The policy in `lib/csp.ts` points both `report-uri` and `report-to` here, so
 * a directive that breaks a real page surfaces as a log line on the first
 * request instead of as a bug report days later. Each violation is emitted
 * through the app's structured JSON logger as `csp.violation`, which is the
 * same stream the rest of the tier writes to — whatever ingests those logs
 * (the platform's log drain, an alerting rule on the event name) picks the
 * violations up with no extra wiring.
 *
 * Notes on the shape of this handler, all of which follow from the endpoint
 * being one browsers post to unauthenticated:
 *
 *   • **No origin check.** Reports arrive as no-CORS POSTs the page itself
 *     never sees; Firefox and Safari send them without an `Origin` header at
 *     all, so rejecting on origin would reject the majority of real traffic.
 *     The defences are the body cap and the rate limit instead.
 *   • **Always `204`.** Browsers do nothing useful with an error status and
 *     will happily keep re-posting, so a rejected body is dropped quietly
 *     rather than turned into a retry loop.
 *   • **Bounded work.** The body is capped before parsing and the parser keeps
 *     at most {@link MAX_REPORTS_PER_REQUEST} violations, so one request can
 *     never write an unbounded number of log lines.
 */

/** Largest report body accepted, in bytes. Real reports are ~1 KB. */
const MAX_BODY_BYTES = 16 * 1024;

/** `204` with no body — the only response this endpoint ever gives. */
function accepted(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'csp:report', LIMITS.cspReport);
  if (limited) return limited;

  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return accepted();

  const raw = await req.text().catch(() => '');
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) return accepted();

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return accepted();
  }

  for (const violation of parseCspReports(payload)) {
    logger.warn({ ...violation }, 'csp.violation');
  }

  return accepted();
}
