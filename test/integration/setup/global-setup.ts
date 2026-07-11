/**
 * Jest globalSetup (integration config only).
 *
 * Runs ONCE per `pnpm run test:integration` invocation, BEFORE any
 * test file is loaded. Responsibilities:
 *
 *   1. Load .env.test into process.env. We use `override: true`
 *      because `@prisma/client`'s runtime auto-loads `.env` from
 *      `process.cwd()` the moment it is imported (Prisma bundles
 *      dotenv v17 internally and reads `.env` regardless of any
 *      presence of `.env.test`). Without `override: true`, the
 *      dev DB URL from `.env` would leak into process.env and the
 *      integration run would attempt to migrate the dev DB —
 *      exactly the bug this PR is fixing. The `setupFiles`
 *      `load-env.ts` does the same for per-test-file resolution.
 *   2. Run `prisma migrate deploy` against the test DATABASE_URL so
 *      every spec finds the schema they expect. The named volume on
 *      the postgres-test container makes this idempotent and cheap
 *      after the first bring-up.
 *   3. Seed a baseline tenant so specs that assume "some tenant
 *      exists" (prisma-promotion.repository.integration.spec uses
 *      `tenant.findFirst()`) get a non-empty DB. The seed uses
 *      upsert so it is safe to re-run.
 *   4. Safety check: refuse to run if the resolved URL still looks
 *      like the dev DB. Defense-in-depth at the boundary that
 *      shells out to `prisma` matters more than anywhere else.
 *
 * The seeded tenant IDs are exported as constants so specs can
 * reference them by ID rather than re-querying. Imported from
 * `test/integration/reset-db.ts`, which exports both the constants
 * AND the prisma client + reset helpers.
 */
import * as dotenv from 'dotenv';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  BASELINE_TENANT_ID,
  BASELINE_TENANT_NAME,
  BASELINE_TENANT_SLUG,
} from '../reset-db';

const envTestPath = path.resolve(process.cwd(), '.env.test');

export default async function globalSetup(): Promise<void> {
  // 1. Load env. `override: true` is REQUIRED — Prisma client auto-loads
  // `.env` into process.env when first imported (see module docstring).
  // Without override, the dev-DB URL would silently win and the migrate
  // step below would touch the dev database.
  dotenv.config({ path: envTestPath, override: true });

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      `[global-setup] DATABASE_URL is unset. Copy .env.test.example to .env.test.`,
    );
  }

  // Refuse if the resolved URL STILL looks like the dev DB. Both
  // checks are loose regex/string-based: an integration run that
  // resolves to port 5432 / database 'nest-practice' is going to
  // touch developer data and must abort loudly.
  if (
    databaseUrl.includes(':5432/') &&
    !databaseUrl.includes('nest-practice-test')
  ) {
    throw new Error(
      `[global-setup] DATABASE_URL=${databaseUrl} looks like the dev DB (port 5432 / nest-practice). ` +
        `Refusing to run. Verify .env.test was loaded and that you're not running \`pnpm exec prisma migrate deploy\` ` +
        `with the dev shell env.`,
    );
  }

  console.log(`[global-setup] DATABASE_URL=${databaseUrl}`);
  console.log('[global-setup] Applying Prisma migrations to test DB…');

  // Run prisma migrate deploy. Force the env on the child so a stale
  // shell DATABASE_URL can't sneak in. The child is a fresh process
  // so its bundled dotenv starts unset — our override is the only
  // DATABASE_URL it sees (besides any `prisma/.env` we don't have).
  const migrateResult = spawnSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy'],
    {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  );
  if (migrateResult.status !== 0) {
    throw new Error(
      `[global-setup] prisma migrate deploy failed (exit ${migrateResult.status}). ` +
        `Is the test DB container up? Run \`pnpm run test:db:up\`. ` +
        `If the failure is 'P3009 migrate found failed migrations', drop the volume with ` +
        `\`pnpm run test:db:down -- -v\` to wipe the test schema and start over.`,
    );
  }

  console.log('[global-setup] Seeding baseline tenant…');
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  try {
    await prisma.tenant.upsert({
      where: { id: BASELINE_TENANT_ID },
      update: {
        name: BASELINE_TENANT_NAME,
        slug: BASELINE_TENANT_SLUG,
        isActive: true,
      },
      create: {
        id: BASELINE_TENANT_ID,
        name: BASELINE_TENANT_NAME,
        slug: BASELINE_TENANT_SLUG,
        isActive: true,
      },
    });
  } finally {
    await prisma.$disconnect();
  }

  console.log('[global-setup] Done.');
}
