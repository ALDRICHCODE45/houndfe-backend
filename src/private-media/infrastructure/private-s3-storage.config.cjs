module.exports = {
  rootDir: '../../..',
  roots: ['<rootDir>/src/private-media/infrastructure'],
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/private-media/infrastructure/private-s3-storage.spec.ts',
  ],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'ES2022',
          module: 'commonjs',
          esModuleInterop: true,
          strict: true,
          skipLibCheck: true,
        },
      },
    ],
  },
  cache: false,
  testTimeout: 10000,
};
