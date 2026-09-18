/**
 * Jest setupFile (integration config only).
 *
 * Runs once per test file BEFORE the test framework loads the spec
 * module. The whole point of being a `setupFile` rather than a
 * `setupFilesAfterEach` is timing: some specs construct PrismaClient
 * at module-eval-time, which means `DATABASE_URL` must already be on
 * `process.env` before the import graph resolves.
 *
 * `.env.test` is authoritative and MUST override the `.env` that
 * `@prisma/client` auto-loads. Prisma bundles dotenv v17 internally
 * and reads `.env` from `process.cwd()` the moment it is required,
 * regardless of any `.env.test`. We therefore load `.env.test` with
 * `override: true` so the test DB URL wins over that auto-loaded dev
 * URL. Without override, `.env`'s dev-DB value would silently survive
 * and an integration run would touch the dev DB.
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

if (!fs.existsSync(envTestPath)) {
  throw new Error(
    `[test:integration setupFile] .env.test is missing at ${envTestPath}. ` +
      `Copy .env.test.example to .env.test (it is gitignored). ` +
      `Alternatively, set DATABASE_URL in the shell before running \`pnpm run test:integration\`.`,
  );
}

// `override: true` is REQUIRED — `@prisma/client`'s runtime auto-loads
// `.env` from `process.cwd()` the moment it is required (Prisma
// bundles dotenv v17 internally and reads `.env` regardless of any
// `.env.test`). Without override, the dev-DB URL from `.env` would
// silently win and an integration run would touch the dev DB.
dotenv.config({ path: envTestPath, override: true });

// Resolve + normalize the test URL before any spec import graph can
// construct a Prisma client. The helper rejects a missing, malformed,
// or dev-targeted URL and never includes the URL in its error text.
process.env.DATABASE_URL = normalizeTestDatabaseUrl(
  process.env.DATABASE_URL,
  '[test:integration setupFile]',
);
