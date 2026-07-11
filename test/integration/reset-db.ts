/**
 * Integration-test DB helpers.
 *
 * Centralises the per-spec cleanup pattern that previously leaked
 * rows into the dev DB. Two fragile tracked-id specs (`prisma-
 * promotion.repository.integration.spec.ts` and `tenant-isolation
 * .spec.ts`) had `afterEach` blocks keyed on `createdIds`-style
 * arrays — a mid-test failure inside the tracked code paths would
 * skip cleanup and leak. The fix is a single truncate-style reset
 * that is robust to ANY failure mode in the spec body.
 *
 * Why TRUNCATE … CASCADE rather than deleteMany per model:
 *
 *   - `Tenant` cascades through every tenant-scoped model in the
 *     schema. A single `TRUNCATE TABLE tenants CASCADE` deletes
 *     them all plus any non-tenant table that references them.
 *   - `User` is non-tenant-scoped, so it survives the tenants
 *     truncate. A handful of integration specs (notably
 *     `tenant-isolation.spec.ts`) create users outside the tenant
 *     graph, so we follow up with a `TRUNCATE TABLE users CASCADE`
 *     to wipe them — safe because the tenants cascade has already
 *     removed Sale/SalePayment/SaleComment rows that FK-reference
 *     users with `Restrict`.
 *   - Non-tenant reference data (Category, Brand, GlobalPriceList,
 *     sat_product_service_keys) is intentionally unaffected —
 *     none of the integration specs we cover seeds those tables.
 *   - Two roundtrips instead of thirty. Significant on the hot
 *     per-test path.
 *
 * After truncation, `resetAndSeedBaseline` re-seeds the baseline
 * tenant so the NEXT spec — and any subsequent test in the same
 * suite — sees a known starting state. Specs that depend on this
 * tenant (the promotion spec's `tenant.findFirst()`) keep working
 * without modification beyond switching to this helper.
 */
import { PrismaClient } from '@prisma/client';

/**
 * Deterministic ID for the always-present baseline tenant. UUIDv4-
 * shaped (`00000000-...`) so it's clearly synthetic and a
 * `findUnique({ where: { id } })` lookup is O(1) — but the
 * `prisma-promotion.repository.integration.spec.ts` keeps using
 * `findFirst()` for backwards-compat so the helper stays
 * orthogonal to the spec.
 */
export const BASELINE_TENANT_ID = '00000000-0000-0000-0000-000000000001';
export const BASELINE_TENANT_SLUG = 'integration-baseline';
export const BASELINE_TENANT_NAME = 'Integration Baseline Tenant';

let _client: PrismaClient | undefined;

/**
 * Lazily-constructed, lazily-connected Prisma client pointed at the
 * test DATABASE_URL. Each integration spec that wants a client calls
 * this — sharing one client across a single suite avoids the
 * per-spec connect overhead that previously inflated test runtime.
 *
 * Throws loudly if DATABASE_URL is unset, since that means
 * globalSetup did not run (or `.env.test` was malformed) — failing
 * fast in a test file is preferable to mysterious timeouts on the
 * first query.
 */
export function integrationPrisma(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      '[test:integration reset-db] DATABASE_URL is unset. ' +
        'Did globalSetup run? Run `pnpm run test:db:up` and ' +
        '`pnpm run test:integration`.',
    );
  }
  if (!_client) {
    _client = new PrismaClient({ datasources: { db: { url } } });
  }
  return _client;
}

/**
 * Truncate tenant-scoped rows + users, then re-seed the baseline
 * tenant so the very next test in this suite (and any subsequent
 * spec) starts from a known state. Idempotent within a single Jest
 * worker.
 *
 * Use this in `afterEach` for the TWO specs being standardised
 * (promotion repo integration, tenant-isolation). Other specs
 * (stock, migration up/down) keep their existing prefix-based
 * cleanup because their truncation would otherwise blow away
 * rows other specs in the same run depend on.
 *
 * Order matters: `TRUNCATE TABLE "tenants" CASCADE` first so the
 * tenant-scoped cascades (Sales, SalePayments, …) are gone BEFORE
 * we touch `users` — otherwise Postgres would block the users
 * truncate on the `Sale→User Restrict` FK.
 */
export async function resetAndSeedBaseline(): Promise<void> {
  const prisma = integrationPrisma();

  await prisma.$executeRawUnsafe('TRUNCATE TABLE "tenants" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "users" CASCADE');

  await prisma.tenant.create({
    data: {
      id: BASELINE_TENANT_ID,
      name: BASELINE_TENANT_NAME,
      slug: BASELINE_TENANT_SLUG,
      isActive: true,
    },
  });
}

/**
 * Disconnect the shared client. Call from `afterAll` so the Jest
 * worker exits cleanly without a leaked pool — relevant in CI
 * where workers are reused across runs.
 */
export async function disconnectIntegrationPrisma(): Promise<void> {
  if (_client) {
    await _client.$disconnect();
    _client = undefined;
  }
}
