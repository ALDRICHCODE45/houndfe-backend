const base = require('./editorial-read.config.cjs');
module.exports = {
  ...base,
  testMatch: [
    '<rootDir>/src/catalog-editorial/http/editorial-context.http.spec.ts',
    '<rootDir>/src/catalog-editorial/infrastructure/prisma-editorial-context.spec.ts',
    '<rootDir>/src/catalog-editorial/http/editorial-vocabulary.http.spec.ts',
    '<rootDir>/src/catalog-editorial/infrastructure/prisma-editorial-vocabulary.spec.ts',
    '<rootDir>/src/catalog-editorial/infrastructure/editorial-reader-authority.spec.ts',
  ],
};
