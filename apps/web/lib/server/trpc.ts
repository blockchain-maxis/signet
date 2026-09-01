import { initTRPC, TRPCError } from '@trpc/server';
import {
  getProfile,
  getOperationsResult,
  listHandles,
  isValidHandle,
  computeStats,
} from '../profiles.ts';
import { logger } from '../logger.ts';
import { rateLimit } from '../rate-limit.ts';
import { verifySession, SESSION_COOKIE } from '../auth.ts';
import { clientIp, isSameOriginHeaders } from '../security.ts';
import { getAccount, unlinkWallet, updateAccount, normalizeAccountUpdate } from './account.ts';
import { boundCount, lookupWallet, resolveHandle } from './registry-read.ts';

/**
 * tRPC server setup.
 *
 * The context carries request-derived data shared by every procedure: the
 * incoming headers, a per-request id for tracing, and the caller's ip (for
 * rate limiting). Profile data is read lazily inside resolvers via
 * `@/lib/profiles`, so the API works with or without Postgres.
 */
export interface Context {
  headers: Headers;
  requestId: string;
  ip: string;
}

export function createContext(headers: Headers): Context {
  const requestId = headers.get('x-request-id') ?? globalThis.crypto.randomUUID();
  return { headers, requestId, ip: clientIp(headers) };
}

const t = initTRPC.context<Context>().create();

export const router = t.router;

/** Logs each call (path, type, duration, outcome) with the request id. */
const observed = t.procedure.use(async ({ ctx, path, type, next }) => {
  const start = Date.now();
  const res = await next();
  logger.info(
    { requestId: ctx.requestId, path, type, ok: res.ok, durationMs: Date.now() - start },
    'trpc.request',
  );
  return res;
});

/**
 * Per-ip rate limit on top of logging.
 *
 * Failures here (and in `protectedProcedure` below) are raised as `TRPCError`
 * rather than bare `Error`s: tRPC maps an unrecognised throw to
 * `INTERNAL_SERVER_ERROR`, which reported every rate-limit and auth rejection
 * as an HTTP 500. Clients could not tell "sign in again" from "back off" from
 * "the server broke", and every expected rejection polluted 5xx monitoring.
 */
const publicProcedure = observed.use(async ({ ctx, path, next }) => {
  const { ok, remaining } = await rateLimit(`${ctx.ip}:${path}`);
  if (!ok) {
    logger.warn({ requestId: ctx.requestId, path, ip: ctx.ip }, 'trpc.rateLimited');
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many requests' });
  }
  void remaining;
  return next();
});

export { publicProcedure };

/** Read + verify the session cookie from the request headers (returns the G… address). */
async function sessionAddress(headers: Headers): Promise<string | null> {
  const cookie = headers.get('cookie');
  if (!cookie) return null;
  const prefix = `${SESSION_COOKIE}=`;
  const part = cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(prefix));
  if (!part) return null;
  return verifySession(decodeURIComponent(part.slice(prefix.length)));
}

/**
 * Authenticated procedure: requires a valid session cookie and exposes the
 * caller's `address` on the context. Mutations additionally enforce a
 * same-origin check (CSRF defense on top of the SameSite=Lax session cookie).
 */
const protectedProcedure = publicProcedure.use(async ({ ctx, type, next }) => {
  if (type === 'mutation' && !isSameOriginHeaders(ctx.headers)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Cross-origin request rejected' });
  }
  const address = await sessionAddress(ctx.headers);
  if (!address) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
  return next({ ctx: { ...ctx, address } });
});

/** Lightweight validator: ensures a well-formed handle without a schema lib. */
function handleInput(raw: unknown): { handle: string } {
  const handle = String((raw as { handle?: unknown })?.handle ?? '').toLowerCase();
  if (!isValidHandle(handle)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid handle' });
  }
  return { handle };
}

/** Stellar account address: G… or C… followed by 55 base32 chars. */
const STELLAR_ADDR_RE = /^[GC][A-Z2-7]{55}$/;

function walletInput(raw: unknown): { wallet: string } {
  const wallet = String((raw as { wallet?: unknown })?.wallet ?? '');
  if (!STELLAR_ADDR_RE.test(wallet)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid wallet address' });
  }
  return { wallet };
}

/** Procedures backing the public-facing profile surface. */
const profileRouter = router({
  list: publicProcedure.query(() => listHandles()),

  byHandle: publicProcedure.input(handleInput).query(async ({ input }) => {
    const profile = await getProfile(input.handle);
    if (!profile) return null;
    const { operations, truncated, cap, source } = await getOperationsResult(input.handle);
    return {
      handle: input.handle,
      profile,
      stats: computeStats(operations),
      operations,
      // The operations window is bounded, so consumers get the completeness of
      // the read alongside it: `truncated` means `operations` and every count
      // derived from it are lower bounds, not totals.
      truncated,
      cap,
      source,
    };
  }),
});

/** Authenticated account surface backing the dashboard. */
const accountRouter = router({
  me: protectedProcedure.query(({ ctx }) => getAccount(ctx.address)),

  update: protectedProcedure
    .input(normalizeAccountUpdate)
    .mutation(({ ctx, input }) => updateAccount(ctx.address, input)),

  // Removes a wallet from the caller's own profile. `unlinkWallet` itself
  // refuses the primary wallet and any wallet bound to a different profile
  // (see account.ts); `protectedProcedure` supplies the session + same-origin
  // guard every other mutation here gets.
  unlinkWallet: protectedProcedure
    .input(walletInput)
    .mutation(({ ctx, input }) => unlinkWallet(ctx.address, input.wallet)),
});

/**
 * On-chain identity registry reads (handle → wallet, wallet → handle, count).
 *
 * These ask the contract directly through `registry-read`'s view simulations
 * rather than reconstructing state from the event stream. The event scan only
 * sees a bounded ledger window, so it silently missed any binding older than
 * that window — `count` in particular reported 0 against a registry whose own
 * `count()` was non-zero. It was also three paginated RPC round trips to
 * answer what one simulation answers.
 */
const registryRouter = router({
  resolve: publicProcedure.input(handleInput).query(async ({ input }) => {
    const wallet = await resolveHandle(input.handle);
    return wallet ? { handle: input.handle, wallet } : null;
  }),

  lookup: publicProcedure.input(walletInput).query(async ({ input }) => {
    const handle = await lookupWallet(input.wallet);
    return handle ? { handle, wallet: input.wallet } : null;
  }),

  // `null` means the registry could not be read; callers must not render that
  // as an empty registry. See `boundCount`.
  count: publicProcedure.query(async () => ({ count: await boundCount() })),
});

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true, service: 'signet', ts: Date.now() })),
  profile: profileRouter,
  account: accountRouter,
  registry: registryRouter,
});

export type AppRouter = typeof appRouter;
