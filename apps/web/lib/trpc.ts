import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from './server/trpc';

/**
 * React Query-backed tRPC client for the authenticated dashboard surface.
 *
 * `createTRPCReact` gives every procedure typed `useQuery`/`useMutation` hooks
 * that share a single React Query cache, so client components get caching,
 * request deduplication, and invalidation for free. `AppRouter` is imported as
 * a type only, so no server modules (fs, crypto, Prisma) reach the client
 * bundle. `trpc-provider.tsx` wires the transport and mounts the providers;
 * public read surfaces stay server-rendered and call the profile helpers
 * directly rather than going through this client.
 */
export const trpc = createTRPCReact<AppRouter>();
