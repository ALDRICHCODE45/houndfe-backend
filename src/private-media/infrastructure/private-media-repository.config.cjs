module.exports = {
  ...require('./private-media-postgres.config.cjs'),
  testMatch: [
    '<rootDir>/src/private-media/infrastructure/prisma-private-media.repository.spec.ts',
    '<rootDir>/src/private-media/infrastructure/prisma-private-media.repository.integration.spec.ts',
  ],
};
