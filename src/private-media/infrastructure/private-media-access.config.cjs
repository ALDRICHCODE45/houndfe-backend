module.exports = {
  ...require('./private-media-postgres.config.cjs'),
  roots: ['<rootDir>/src/private-media/application'],
  testMatch: [
    '<rootDir>/src/private-media/application/private-media-access.spec.ts',
  ],
};
