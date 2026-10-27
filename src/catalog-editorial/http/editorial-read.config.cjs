module.exports = {
  rootDir: '../../..',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/catalog-editorial/http/editorial-read.http.spec.ts',
  ],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'ES2022',
          module: 'commonjs',
          esModuleInterop: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          strict: true,
          skipLibCheck: true,
        },
      },
    ],
  },
  cache: false,
  testTimeout: 10000,
};
