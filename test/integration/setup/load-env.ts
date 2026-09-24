/**
 * Jest setupFile (integration config only).
 *
 * Runs once per test file BEFORE the test framework loads the spec
 * module. The whole point of being a `setupFile` rather than a
 * `setupFilesAfterEach` is timing: some specs construct PrismaClient
 * at module-eval-time, which means `DATABASE_URL` must already be on
 * `process.env` before the import graph resolves.
 *
 * When present, `.env.test` is authoritative and overrides Prisma's
 * auto-loaded `.env`. Without `.env.test`, a shell DATABASE_URL is accepted
 * only with the caller's explicit HOUNDFE_TEST_DATABASE_URL_FROM_SHELL=1
 * marker. Prisma can import `.env` before this setup file runs, so the marker
 * distinguishes a deliberate shell test invocation from implicit dotenv.
 * Both sources pass the same test-target guard before any spec imports Prisma.
 *
 * After load, the resolved value is normalized through
 * `normalizeTestDatabaseUrl` BEFORE any spec import graph constructs
 * Prisma. The helper pins an ambiguous `localhost` host to `127.0.0.1`,
 * enforces the test-DB safety guard, and throws loudly (without ever
 * echoing the URL) if the value is missing or malformed.
 */
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeTestDatabaseUrl } from './test-database-url';

const envTestPath = path.resolve(process.cwd(), '.env.test');

if (fs.existsSync(envTestPath)) {
  // Override Prisma's auto-loaded `.env`: the explicit test file wins.
  dotenv.config({ path: envTestPath, override: true });
} else if (
  process.env.HOUNDFE_TEST_DATABASE_URL_FROM_SHELL !== '1' ||
  !process.env.DATABASE_URL
) {
  // Prisma may already have auto-loaded `.env`; a URL alone cannot prove
  // shell provenance. Require the caller's separate explicit test marker.
  throw new Error(
    `[test:integration setupFile] .env.test is missing at ${envTestPath}. ` +
      `Provide a guarded .env.test, or set both DATABASE_URL and ` +
      `HOUNDFE_TEST_DATABASE_URL_FROM_SHELL=1 explicitly in the shell.`,
  );
}

// Resolve + normalize the test URL before any spec import graph can
// construct a Prisma client. The helper rejects a missing, malformed,
// or dev-targeted URL and never includes the URL in its error text.
process.env.DATABASE_URL = normalizeTestDatabaseUrl(
  process.env.DATABASE_URL,
  '[test:integration setupFile]',
);
