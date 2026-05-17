import { PrismaClient } from '@signet/db';
import { logger } from './logger.js';

export const prisma = new PrismaClient({ log: ['error'] });

export async function connectDb(): Promise<void> {
  await prisma.$connect();
  logger.info({}, 'db.connected');
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
  logger.info({}, 'db.disconnected');
}
