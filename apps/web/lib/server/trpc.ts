import { initTRPC } from '@trpc/server';
import { getProfile, getOperations, listHandles, isValidHandle, computeStats } from '../profiles.ts';
import { fetchLiveDirectory } from '../directory.ts';
import { logger } from '../logger.ts';
import { rateLimit } from '../rate-limit.ts';
import { verifySession, SESSION_COOKIE } from '../auth.ts';
import { isSameOriginHeaders } from '../security.ts';
import { getAccount, updateAccount, normalizeAccountUpdate } from './account.ts';

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
  const ip =
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    headers.get('x-real-ip') ??
    'unknown';
  return { headers, requestId, ip };
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

/** Per-ip rate limit on top of logging. */
const publicProcedure = observed.use(async ({ ctx, path, next }) => {
  const { ok, remaining } = await rateLimit(`${ctx.ip}:${path}`);
  if (!ok) {
    logger.warn({ requestId: ctx.requestId, path, ip: ctx.ip }, 'trpc.rateLimited');
    throw new Error('Too many requests');
  }
  void remaining;
  return next();
});

export { publicProcedure };

/** Read + verify the session cookie from the request headers (returns the G… address). */
function sessionAddress(headers: Headers): string | null {
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
    throw new Error('Cross-origin request rejected');
  }
  const address = sessionAddress(ctx.headers);
  if (!address) throw new Error('Unauthorized');
  return next({ ctx: { ...ctx, address } });
});

/** Lightweight validator: ensures a well-formed handle without a schema lib. */
function handleInput(raw: unknown): { handle: string } {
  const handle = String((raw as { handle?: unknown })?.handle ?? '').toLowerCase();
  if (!isValidHandle(handle)) throw new Error('Invalid handle');
  return { handle };
}

/** Stellar account address: G… or C… followed by 55 base32 chars. */
const STELLAR_ADDR_RE = /^[GC][A-Z2-7]{55}$/;

function walletInput(raw: unknown): { wallet: string } {
  const wallet = String((raw as { wallet?: unknown })?.wallet ?? '');
  if (!STELLAR_ADDR_RE.test(wallet)) throw new Error('Invalid wallet address');
  return { wallet };
}

/** Procedures backing the public-facing profile surface. */
const profileRouter = router({
  list: publicProcedure.query(() => listHandles()),

  byHandle: publicProcedure.input(handleInput).query(async ({ input }) => {
    const profile = await getProfile(input.handle);
    if (!profile) return null;
    const operations = await getOperations(input.handle);
    return {
      handle: input.handle,
      profile,
      stats: computeStats(operations),
      operations,
    };
  }),
});

/** Authenticated account surface backing the dashboard. */
const accountRouter = router({
  me: protectedProcedure.query(({ ctx }) => getAccount(ctx.address)),

  update: protectedProcedure
    .input(normalizeAccountUpdate)
    .mutation(({ ctx, input }) => updateAccount(ctx.address, input)),
});

/** On-chain identity registry reads (handle → wallet, wallet → handle, count). */
const registryRouter = router({
  resolve: publicProcedure.input(handleInput).query(async ({ input }) => {
    const directory = await fetchLiveDirectory();
    if (!directory) return null;
    const entry = directory.find((e) => e.handle === input.handle);
    return entry ? { handle: entry.handle, wallet: entry.wallet } : null;
  }),

  lookup: publicProcedure.input(walletInput).query(async ({ input }) => {
    const directory = await fetchLiveDirectory();
    if (!directory) return null;
    const entry = directory.find((e) => e.wallet === input.wallet);
    return entry ? { handle: entry.handle, wallet: entry.wallet } : null;
  }),

  count: publicProcedure.query(async () => {
    const directory = await fetchLiveDirectory();
    return { count: directory?.length ?? 0 };
  }),
});

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true, service: 'signet', ts: Date.now() })),
  profile: profileRouter,
  account: accountRouter,
  registry: registryRouter,
});

export type AppRouter = typeof appRouter;
