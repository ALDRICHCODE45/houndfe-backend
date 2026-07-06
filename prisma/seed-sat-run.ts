/**
 * Standalone runner for the SAT c_ClaveProdServ catalog ingest.
 *
 * Loads ONLY the SAT catalog into `SatProductServiceKey`, without running the
 * full multi-tenant seed (`prisma/seed.ts`). Use this to populate the catalog
 * on a fresh machine when the rest of the DB already has data you want to keep.
 *
 * Idempotent: `ingestSatCatalog` uses `createMany({ skipDuplicates: true })`
 * with `key` as the PK, so re-runs leave the row count stable.
 *
 * Run with: `pnpm run seed:sat`
 */
import { PrismaClient } from '@prisma/client';
import { ingestSatCatalog } from './seed-sat';

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await ingestSatCatalog(prisma);
    console.log(
      `SAT catalog ingest: ${result.totalWritten} rows from ${result.source} (${result.batches} batches)`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('SAT ingest failed:', e);
  process.exit(1);
});
