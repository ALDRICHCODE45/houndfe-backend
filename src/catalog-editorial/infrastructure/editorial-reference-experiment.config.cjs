module.exports = {
  rootDir: '../../..',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/catalog-editorial/infrastructure/editorial-reference-experiment-runner.spec.ts',
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
        },
      },
    ],
  },
  maxWorkers: 1,
  testTimeout: 10000,
  cache: false,
};
