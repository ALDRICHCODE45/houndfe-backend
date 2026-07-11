/**
 * Integration-test Jest config.
 *
 * Mirror image of `jest.config.js` (unit). Accepts ONLY the specs
 * that exercise a real Postgres connection:
 *
 *   - `*.integration.spec.ts` under `src/`
 *   - DB-hitting specs under `prisma/` (e4, the stock repo spec, the
 *     promotions migration up/down).
 *   - `tenant-isolation.spec.ts` (DB-backed, no `.integration` suffix).
 *
 * Pure / mocked / fs-parsing specs MUST stay under the unit config:
 *   - `*.repository.spec.ts` (mock Prisma) under `src/`.
 *   - `prisma/*migration-drift*.spec.ts` (filesystem text parsing).
 *   - `prisma/low-stock-migration-drift.spec.ts`.
 *   - `prisma/seed-sat.spec.ts`.
 *
 * Env loading:
 *   - `setupFiles` runs `dotenv.config({ path: '.env.test' })` so the
 *     `DATABASE_URL` (and Joi keys if a spec boots `ConfigModule`)
 *     is set BEFORE Prisma clients are constructed.
 *   - `globalSetup` runs `prisma migrate deploy` against the test
 *     DATABASE_URL and seeds a baseline tenant — see
 *     `test/integration/setup/global-setup.ts`. Without this the
 *     promotion spec's `tenant.findFirst()` throws on an empty DB.
 *
 * `runInBand` is a per-invocation flag (`pnpm run test:integration`
 * passes it). Multiple Jest workers hammering one test DB is a recipe
 * for cross-spec interference on truncation-style cleanup.
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts', 'tsx'],
  // Drop the default roots so `testMatch` is authoritative — we do
  // NOT want Jest to discover anything else.
  roots: ['<rootDir>/src', '<rootDir>/prisma'],
  testMatch: [
    // Naming convention under src/.
    '<rootDir>/src/**/*.integration.spec.ts',
    '<rootDir>/src/shared/prisma/tenant-isolation.spec.ts',
    // DB-hitting specs under prisma/.
    '<rootDir>/prisma/prisma-stock-alert-state.repository.integration.spec.ts',
    '<rootDir>/prisma/e4-concurrent-stock-alert.spec.ts',
    '<rootDir>/prisma/promotions-in-sale-migration-up-down.spec.ts',
  ],
  transform: {
    '^.+\\.(t|j)sx?$': 'ts-jest',
  },
  testEnvironment: 'node',
  // Load .env.test BEFORE Prisma is constructed (some specs eager-init
  // PrismaClient at module top level).
  setupFiles: ['<rootDir>/test/integration/setup/load-env.ts'],
  globalSetup: '<rootDir>/test/integration/setup/global-setup.ts',
  globalTeardown: '<rootDir>/test/integration/setup/global-teardown.ts',
};
