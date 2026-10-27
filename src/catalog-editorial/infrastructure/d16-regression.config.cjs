const target = process.env.CATALOG_EDITORIAL_D16_TEST_CONTAINER;
if (!target) throw new Error('Explicit D16 regression target required');
// Only enables the historical suite's presence gate. Admission stays in D16.
process.env.CATALOG_EDITORIAL_TEST_CONTAINER = target;
module.exports = {
  ...require('./d16-postgres.config.cjs'),
  testMatch: [
    '<rootDir>/src/catalog-editorial/infrastructure/isolated-postgres.spec.ts',
  ],
  moduleNameMapper: {
    '^\\./isolated-postgres-runner$':
      '<rootDir>/src/catalog-editorial/infrastructure/d16-regression-adapter.ts',
  },
};
