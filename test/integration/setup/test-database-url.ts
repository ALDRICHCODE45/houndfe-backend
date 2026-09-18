/**
 * Shared integration-harness DATABASE_URL normalization.
 *
 * Both the per-file Jest `setupFiles` entry (`load-env.ts`) and the
 * one-shot `globalSetup` (`global-setup.ts`) resolve the test DB URL
 * through this single helper, BEFORE any Prisma client is constructed
 * or `prisma migrate deploy` is spawned.
 *
 * Why normalization exists: the test host resolves `localhost` to
 * `::1` first, and the test PostgreSQL container does not reliably
 * accept that IPv6 path under load, so `localhost` intermittently
 * times out. Rewriting ONLY the `localhost` hostname to `127.0.0.1`
 * removes that dual-stack ambiguity. Every other component —
 * credentials, database, port, query parameters, and any explicit
 * IPv4 / IPv6 / remote/CI host — remains semantically unchanged.
 *
 * Safety: the URL is never echoed in thrown messages, so credentials
 * cannot leak into integration output.
 */

/** Database name that marks the dedicated integration-test target. */
const TEST_DATABASE_NAME = 'nest-practice-test';

/** Dev-stack host port that an integration run must never target. */
const DEV_DATABASE_PORT = '5432';

/**
 * Resolve `rawUrl` into the normalized integration DATABASE_URL.
 *
 * @param rawUrl - the raw `process.env.DATABASE_URL` value.
 * @param contextLabel - non-secret caller label used in error messages
 *   (for example `[global-setup]`).
 * @returns the normalized URL string, safe to assign back to
 *   `process.env.DATABASE_URL`.
 */
export function normalizeTestDatabaseUrl(
  rawUrl: string | undefined,
  contextLabel: string,
): string {
  if (!rawUrl) {
    throw new Error(
      `${contextLabel} DATABASE_URL is unset. ` +
        `Copy .env.test.example to .env.test (it is gitignored) and re-run.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      `${contextLabel} DATABASE_URL is not a valid connection URL. ` +
        `Expected a postgresql:// string; refusing to echo it because it may carry credentials.`,
    );
  }

  // Pathname is `/` or `/dbname`; decode so an encoded name still
  // matches the guard. Fall back to the raw segment if decoding fails.
  const rawPath = parsed.pathname.replace(/^\//, '');
  let databaseName = rawPath;
  try {
    databaseName = decodeURIComponent(rawPath);
  } catch {
    databaseName = rawPath;
  }

  // Refuse the known dev target: port 5432 with any database other than
  // the dedicated test DB. Never include the URL in the error.
  if (
    parsed.port === DEV_DATABASE_PORT &&
    databaseName !== TEST_DATABASE_NAME
  ) {
    throw new Error(
      `${contextLabel} DATABASE_URL targets the dev DB ` +
        `(port ${DEV_DATABASE_PORT} with a database other than '${TEST_DATABASE_NAME}'). ` +
        `Refusing to run integration tests against developer data.`,
    );
  }

  // Dual-stack fix: pin the ambiguous loopback hostname to IPv4.
  // Explicit hosts (IPv4, IPv6, remote/CI) are left untouched.
  if (parsed.hostname === 'localhost') {
    parsed.hostname = '127.0.0.1';
  }

  return parsed.toString();
}
