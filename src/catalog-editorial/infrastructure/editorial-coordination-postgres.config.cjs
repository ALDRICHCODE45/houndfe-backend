module.exports = {
  rootDir: '../../..',
  testEnvironment: 'node',
  cache: false,
  testMatch: [
    '<rootDir>/src/catalog-editorial/infrastructure/editorial-coordination-postgres-harness.spec.ts',
  ],
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
