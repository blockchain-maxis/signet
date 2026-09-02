import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from './server/trpc';
import { appUrl } from './public-env.ts';

/**
 * Vanilla tRPC client.
 *
 * TODO(signet): swap to the React Query integration (@trpc/react-query) with a
 * provider once we build interactive UI; this vanilla client is enough to wire
 * up and verify the stub.
 */
function getBaseUrl(): string {
  if (typeof window !== 'undefined') return '';
  return appUrl();
}

export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${getBaseUrl()}/api/trpc`,
    }),
  ],
});
