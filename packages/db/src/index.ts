import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';
export { PrismaClient } from '@prisma/client';

// Singleton for Next.js (prevents multiple instances in development HMR)
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? new PrismaClient({ log: ['error'] });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
