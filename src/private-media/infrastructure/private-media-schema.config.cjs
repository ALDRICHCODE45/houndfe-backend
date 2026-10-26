module.exports = {
  ...require('./private-media-postgres.config.cjs'),
  roots: ['<rootDir>/prisma', '<rootDir>/src/private-media/infrastructure'],
  testMatch: [
    '<rootDir>/prisma/private-media-migration-drift.spec.ts',
    '<rootDir>/src/private-media/infrastructure/private-media-schema.integration.spec.ts',
  ],
};
