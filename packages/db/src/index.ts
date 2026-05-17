// Re-export the generated Prisma client so apps import it via `@signet/db`.
// Run `pnpm db:generate` (or `pnpm install`, which triggers postinstall) to
// generate the client before typechecking.
//
// TODO(signet): add a shared, pre-configured PrismaClient singleton here once
// the schema is expanded (connection pooling, logging, etc.).
export * from '@prisma/client';
export { PrismaClient } from '@prisma/client';
