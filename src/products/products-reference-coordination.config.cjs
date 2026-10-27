module.exports = {
  rootDir: '../..',
  testEnvironment: 'node',
  cache: false,
  testMatch: [
    '<rootDir>/src/products/products-variant-reference.spec.ts',
    '<rootDir>/src/products/products-variant-removal-reference.spec.ts',
    '<rootDir>/src/products/products.service.spec.ts',
  ],
  moduleNameMapper: { '^src/(.*)$': '<rootDir>/src/$1' },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          target: 'ES2023',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          strictNullChecks: true,
          skipLibCheck: true,
          isolatedModules: false,
        },
        diagnostics: true,
      },
    ],
  },
};
