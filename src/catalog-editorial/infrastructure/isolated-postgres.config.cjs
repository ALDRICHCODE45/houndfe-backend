if (!process.env.CATALOG_EDITORIAL_TEST_CONTAINER) {
  throw new Error('Explicit isolated container required; no default database');
}
module.exports = {
  rootDir: '../../..',
  roots: ['<rootDir>/src/catalog-editorial'],
  testMatch: [
    '<rootDir>/src/catalog-editorial/infrastructure/isolated-postgres.spec.ts',
  ],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: { incremental: false } }] },
  testEnvironment: 'node',
  testTimeout: 20000,
};
