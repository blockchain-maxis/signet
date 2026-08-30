import {
  DATABASE_REQUIRED_CODE,
  DatabaseRequiredError,
  requireDatabase,
} from '../../../../../lib/profiles.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `POST /api/cli/pair/complete` — the point at which a CLI pairing becomes a
 * `Wallet` row.
 *
 * **This route currently implements the database precondition and nothing
 * else.** The pairing verification itself — the challenge, the signature, the
 * single-use code — is #268's, and this deliberately does not guess at it:
 * the handler returns `501` once the precondition passes, rather than
 * pretending to complete a pairing it has not verified.
 *
 * The precondition is checked **first**, before anything else, and that
 * ordering is the point of #277. A link is a row in Postgres. With no
 * `DATABASE_URL` there is nowhere to put it, and the read path's graceful
 * fall-through (`safeDbProfile`, `safeDbOperations` in `lib/profiles.ts`)
 * would make the link appear to succeed while persisting nothing. Failing
 * closed here means the developer is told the truth at the moment they act,
 * instead of discovering it later from an unrelated command.
 *
 * See `docs/CLI.md` and #191 (database provisioning).
 */
export async function POST(): Promise<Response> {
  try {
    // Before parsing the body, before touching a signature: if the result
    // cannot be stored, nothing else about this request matters.
    requireDatabase('CLI wallet linking');
  } catch (err) {
    if (err instanceof DatabaseRequiredError) {
      return Response.json(
        {
          error: err.code,
          message: err.message,
          // The flag a client branches on. Without it the CLI has to
          // string-match a message to know this is not the user's fault.
          isConfigurationError: true,
          docs: 'https://github.com/blockchain-maxis/signet/blob/main/docs/CLI.md#linking-requires-a-database',
        },
        {
          // 503, not 400 or 500: the service is correctly configured to refuse
          // rather than broken, and the condition is not the caller's doing.
          status: 503,
          // Nothing here changes until an operator provisions a database.
          headers: { 'cache-control': 'no-store' },
        },
      );
    }
    throw err;
  }

  return Response.json(
    {
      error: 'not_implemented',
      message:
        'Pairing verification is not implemented yet (see issue #268). The database ' +
        'precondition for linking is enforced above.',
    },
    { status: 501 },
  );
}

/**
 * `GET /api/cli/pair/complete` — whether linking can succeed at all right now.
 *
 * Exists so the `/link` page can warn **before** the developer approves,
 * rather than after they have signed something that cannot be stored.
 */
export function GET(): Response {
  const configured = process.env.DATABASE_URL ? true : false;
  return Response.json(
    {
      available: configured,
      ...(configured ? {} : { reason: DATABASE_REQUIRED_CODE }),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
