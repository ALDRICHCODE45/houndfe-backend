module.exports = {
  rootDir: '../../..',
  roots: ['<rootDir>/src/private-media/infrastructure'],
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/private-media/infrastructure/private-media-config.spec.ts',
  ],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: {
      target: 'ES2022', module: 'commonjs', esModuleInterop: true,
      skipLibCheck: true, isolatedModules: false,
    } }],
  },
  cache: false,
  testTimeout: 10000,
};
