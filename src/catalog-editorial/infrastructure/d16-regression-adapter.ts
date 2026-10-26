import type { PrismaClient } from '@prisma/client';
import { d16Postgres } from './d16-postgres-runner';

/** D16-only Jest mapping; never imports or repoints the retired runner. */
export async function isolatedPostgres(): Promise<PrismaClient> {
  const db = await d16Postgres();
  try {
    await db.second.$disconnect();
    return db.first;
  } catch (error) {
    await Promise.allSettled([db.first.$disconnect(), db.second.$disconnect()]);
    throw error;
  }
}
