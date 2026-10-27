module.exports = {
  ...require('./private-s3-storage.config.cjs'),
  roots: ['<rootDir>/src/private-media'],
  testMatch: [
    '<rootDir>/src/private-media/application/private-media.service.spec.ts',
    '<rootDir>/src/private-media/private-media.factory.spec.ts',
    '<rootDir>/src/private-media/private-media.flow.spec.ts',
  ],
};
