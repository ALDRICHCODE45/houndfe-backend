/**
 * Unit-test Jest config.
 *
 * Excludes everything that touches a real DB:
 *   - All `*.integration.spec.ts` files (the naming convention).
 *   - DB-hitting specs under `prisma/` that don't follow the
 *     `.integration.spec.ts` suffix (e4-concurrent-stock-alert, the
 *     promotions migration up/down). The `SKIP_DB_INTEGRATION` guard
 *     inside each of those is defense-in-depth, but unit-test runs
 *     must NEVER make a Postgres roundtrip.
 *   - `tenant-isolation.spec.ts` lives under `src/` but is unprefixed
 *     (`tenant-isolation.spec.ts`) because the suffix convention was
 *     introduced after the file was merged. It is DB-backed and is
 *     also the primary smoke-test for the CLS tenant-scoping factory;
 *     keeping it out of the unit run is mandatory.
 *
 * The integration config (`jest.integration.config.js`) is its mirror
 * image: it accepts ONLY those excluded files plus the globalSetup +
 * setupFile chain in `test/integration/setup/`. Result: `pnpm test`
 * never reaches the dev DB, and `pnpm test:integration` is the only
 * path that can.
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts', 'tsx'],
  roots: ['src', 'prisma'],
  testRegex: '.*\\.spec\\.(t|j)sx?$',
  transform: {
    '^.+\\.(t|j)sx?$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  testPathIgnorePatterns: [
    '/node_modules/',
    // Integration-spec naming convention.
    '\\.integration\\.spec\\.ts$',
    // DB-hitting specs without the integration suffix.
    '/tenant-isolation\\.spec\\.ts$',
    '/e4-concurrent-stock-alert\\.spec\\.ts$',
    '/promotions-in-sale-migration-up-down\\.spec\\.ts$',
    // Integration-runtime artifacts (globalSetup / setupFile are owned
    // by the integration config — never picked up here).
    '/test/integration/',
  ],
};
