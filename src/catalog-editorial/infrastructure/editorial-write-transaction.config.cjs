module.exports = {
  rootDir: '../../..',
  testEnvironment: 'node',
  cache: false,
  testMatch: [
    '<rootDir>/src/catalog-editorial/domain/contextual-document.spec.ts',
    '<rootDir>/src/catalog-editorial/infrastructure/prisma-locked-editorial-references.spec.ts',
    '<rootDir>/src/catalog-editorial/infrastructure/prisma-editorial-write-transaction.spec.ts',
    '<rootDir>/src/catalog-editorial/infrastructure/prisma-editorial-authority.spec.ts',
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
