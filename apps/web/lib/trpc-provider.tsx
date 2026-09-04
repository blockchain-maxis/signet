'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { trpc } from './trpc';

/**
 * Mounts the tRPC + React Query providers for the dashboard.
 *
 * The `QueryClient` and tRPC client are created once per mount via `useState`
 * initialisers rather than at module scope: a module-level client would be
 * shared across every request on the server and leak one user's cached data
 * into another's render. The session cookie rides along automatically on these
 * same-origin `/api/trpc` requests, which is what authorises `account.*`.
 */
export function TRPCProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [httpBatchLink({ url: '/api/trpc' })],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
