/**
 * Jest setupFile (integration config only).
 *
 * Runs once per test file BEFORE the test framework loads the spec
 * module. The whole point of being a `setupFile` rather than a
 * `setupFilesAfterEach` is timing: some specs construct PrismaClient
 * at module-eval-time, which means `DATABASE_URL` must already be on
 * `process.env` before the import graph resolves.
 *
 * `dotenv` does NOT overwrite existing env vars by default. That is
 * the right default here: the test DB URL must NEVER be overridden by
 * a stray shell-exported `DATABASE_URL=...:5432/nest-practice` left
 * over from a previous dev session. Order-of-resolution:
 *   1. Real env (already-set vars in the shell / CI).
 *   2. `.env.test` values, which only fill in the gaps.
 *
 * The reverse case — `.env.test` silently overwriting a real
 * `DATABASE_URL=localhost:5432/nest-practice` — is the exact bug we
 * are fixing. So if a caller has `DATABASE_URL` set externally, we
 * trust it; otherwise we fall back to `.env.test`.
 *
 * Hard guard: if `DATABASE_URL` is still unset after load, throw. We
 * would rather a loud crash than a `pnpm test:integration` that
 * silently writes to the dev DB because the .env.test file went
 * missing.
 */
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

if (!process.env.DATABASE_URL) {
  throw new Error(
    `[test:integration setupFile] DATABASE_URL is unset after loading ${envTestPath}. ` +
      `Aborting to avoid touching the dev DB. Check .env.test.example and copy it verbatim.`,
  );
}

// Safety net — confirm the resolved URL points at the test DB host:port.
// This is a last-resort guard for the case where an operator hand-edits
// `.env.test` and somehow pastes the dev URL back in.
const url = process.env.DATABASE_URL;
if (
  url.includes(':5432/') &&
  !url.includes('nest-practice-test')
) {
  throw new Error(
    `[test:integration setupFile] DATABASE_URL=${url} does not look like the test DB. ` +
      `Expected port 5433 and database name 'nest-practice-test'. ` +
      `Refusing to run integration tests against what appears to be the dev DB.`,
  );
}
