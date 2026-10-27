if (!process.env.CATALOG_EDITORIAL_DEFINITIONS_TEST_CONTAINER) {
  throw new Error(
    'Explicit definitions container required; no default database',
  );
}
module.exports = {
  rootDir: '../../..',
  roots: ['<rootDir>/src/catalog-editorial'],
  testMatch: [
    '<rootDir>/src/catalog-editorial/infrastructure/definitions-postgres.integration.spec.ts',
  ],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: { incremental: false } }] },
  testEnvironment: 'node',
  testTimeout: 20000,
};
