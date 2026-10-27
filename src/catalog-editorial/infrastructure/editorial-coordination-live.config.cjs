module.exports = {
  rootDir: '../../..',
  testEnvironment: 'node',
  cache: false,
  testMatch: [
    '<rootDir>/src/catalog-editorial/infrastructure/*.live.spec.ts',
    '<rootDir>/src/products/**/*.live.spec.ts',
  ],
  maxWorkers: 1,
  testTimeout: 30000,
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        diagnostics: true,
        tsconfig: {
          module: 'commonjs',
          target: 'ES2023',
          esModuleInterop: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          strictNullChecks: true,
          skipLibCheck: true,
          isolatedModules: false,
        },
      },
    ],
  },
};
