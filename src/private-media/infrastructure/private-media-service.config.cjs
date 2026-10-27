module.exports = {
  ...require('./private-s3-storage.config.cjs'),
  roots: ['<rootDir>/src/private-media/application'],
  testMatch: [
    '<rootDir>/src/private-media/application/private-media.service.spec.ts',
  ],
};
