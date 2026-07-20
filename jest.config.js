/**
 * Unit-test Jest config.
 *
 * Excludes everything that touches a real DB:
 *   - All `*.integration.spec.ts` files (the naming convention).
 *   - DB-hitting specs under `prisma/` that don't follow the
 *     `.integration.spec.ts` suffix (e4-concurrent-stock-alert, the
 *     promotions migration up/down). The `SKIP_DB_INTEGRATION` guard
 *     inside each of those is defense-in-depth, but unit-test runs
 *     must NEVER make a Postgres roundtrip.
 *   - `tenant-isolation.spec.ts` lives under `src/` but is unprefixed
 *     (`tenant-isolation.spec.ts`) because the suffix convention was
 *     introduced after the file was merged. It is DB-backed and is
 *     also the primary smoke-test for the CLS tenant-scoping factory;
 *     keeping it out of the unit run is mandatory.
 *
 * The integration config (`jest.integration.config.js`) is its mirror
 * image: it accepts ONLY those excluded files plus the globalSetup +
 * setupFile chain in `test/integration/setup/`. Result: `pnpm test`
 * never reaches the dev DB, and `pnpm test:integration` is the only
 * path that can.
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts', 'tsx'],
  roots: ['src', 'prisma'],
  testRegex: '.*\\.spec\\.(t|j)sx?$',
  transform: {
    '^.+\\.(t|j)sx?$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  testPathIgnorePatterns: [
    '/node_modules/',
    // Integration-spec naming convention.
    '\\.integration\\.spec\\.ts$',
    // DB-hitting specs without the integration suffix.
    '/tenant-isolation\\.spec\\.ts$',
    '/e4-concurrent-stock-alert\\.spec\\.ts$',
    '/promotions-in-sale-migration-up-down\\.spec\\.ts$',
    // Integration-runtime artifacts (globalSetup / setupFile are owned
    // by the integration config — never picked up here).
    '/test/integration/',
  ],
  // `yoga-layout` v3.x is ESM-only AND uses `import.meta.url` to load
  // its embedded WASM binary, which Jest's CommonJS runtime cannot
  // resolve. We map both the bare-module import (`yoga-layout`) and
  // the subpath import (`yoga-layout/load`) to a CJS stub that
  // exposes the Yoga API surface @react-pdf/layout needs. See
  // `src/pdf-generation/__mocks__/yoga-layout.cjs` for the rationale
  // and the surface-area contract. Real engine is loaded at runtime
  // via the on-Node `PdfGenerationService` path (WU4); these mocks
  // are snapshot-only.
  moduleNameMapper: {
    '^yoga-layout$': '<rootDir>/src/pdf-generation/__mocks__/yoga-layout.cjs',
    '^yoga-layout/load$':
      '<rootDir>/src/pdf-generation/__mocks__/yoga-layout.cjs',
  },
  // @react-pdf/renderer v4.x and its transitive ESM deps ship ESM-only
  // source. Jest's default transformIgnorePatterns skips all of
  // node_modules, so without this regex we'd fail with
  // "Cannot use import statement outside a module" the moment any
  // template test imports @react-pdf/renderer.
  //
  // Strategy: match `/node_modules/` (no `^` anchor — we want this
  // to apply ONLY to files inside node_modules, not to our own
  // src/ specs), then a negative lookahead that allows the file
  // through ONLY when the package it belongs to is whitelisted.
  //
  // The `(?:\.pnpm/[^/]+/node_modules/)?` segment is the pnpm twist:
  // pnpm stores transitive deps under
  // `.pnpm/<dir>@<ver>/node_modules/<actual-pkg>/`. We allow ANY
  // `.pnpm/<dir>/node_modules/` prefix (the `<dir>` name includes a
  // version we can't predict, hence `[^/]+`), then check the
  // `<actual-pkg>` against the whitelist.
  //
  // Whitelist rationale:
  //   - `@react-pdf/<sub>` — renderer + every internal @react-pdf pkg.
  //   - `fontkit`, `png-js`, `jay-peg`, `linebreak`, `restructure` —
  //     ESM transitives of @react-pdf/pdfkit (PDF font/image decoder).
  //     Each ships both ESM and CJS bundles, but Jest's resolver
  //     lands on the ESM entry.
  //   - `color-string` + `color-name` — ESM transitives of
  //     @react-pdf/render (SVG path color parsing). `color-name`
  //     has no CJS build.
  //   - `yoga-layout` is REMOVED from the whitelist because
  //     `moduleNameMapper` above redirects it to a CJS mock — we
  //     never want Jest to read the real ESM/WASM package.
  transformIgnorePatterns: [
    'node_modules/(?!(?:\\.pnpm/[^/]+/node_modules/)?(?:@react-pdf/[^/]+|fontkit|png-js|jay-peg|linebreak|restructure|color-string|color-name)(?:/|$))',
    '\\.pnp\\.[^\\/]+$',
  ],
};
