if (!process.env.CATALOG_EDITORIAL_D16_TEST_CONTAINER) {
  throw new Error('Explicit D16 container required; no default database');
}
module.exports = {
  rootDir: '../../..',
  roots: ['<rootDir>/src/catalog-editorial'],
  testMatch: [
    '<rootDir>/src/catalog-editorial/infrastructure/d16-postgres.integration.spec.ts',
    '<rootDir>/src/catalog-editorial/infrastructure/d16-save.integration.spec.ts',
    '<rootDir>/src/catalog-editorial/infrastructure/prisma-locked-editorial-definitions.integration.spec.ts',
  ],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: { incremental: false } }] },
  testEnvironment: 'node',
  testTimeout: 20000,
};
