import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '@/lib/server/trpc';

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    // TODO(signet): build a real context (db, session) here.
    createContext: () => ({}),
  });

export { handler as GET, handler as POST };
