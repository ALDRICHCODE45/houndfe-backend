module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  roots: ['.'],
  testMatch: [
    '<rootDir>/online-catalog-publishing-migration.integration.spec.ts',
  ],
  transform: {
    '^.+\\.(t|j)sx?$': 'ts-jest',
  },
  testEnvironment: 'node',
};