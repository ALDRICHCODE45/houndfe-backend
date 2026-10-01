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
 *
 * Two dedicated targets are accepted:
 *   - `nest-practice-test`: the legacy integration target. Its existing
 *     behavior is unchanged (loopback port guard, `localhost` rewrite,
 *     remote/CI hosts allowed, `postgres:` alias allowed).
 *   - `nest-practice-restock-test`: the isolated RESTOCK-suite target.
 *     Accepted ONLY as the exact tuple `postgresql://127.0.0.1:5433/`.
 *     No remote host, `localhost`, IPv6, missing/other port, or
 *     `postgres:` alias is accepted for this target.
 */

/** Database name that marks the dedicated integration-test target. */
const TEST_DATABASE_NAME = 'nest-practice-test';

/** Database name that marks the dedicated isolated RESTOCK-suite target. */
const RESTOCK_DATABASE_NAME = 'nest-practice-restock-test';

/** Docker Compose exposes the dedicated test DB on this loopback port. */
const LOCAL_TEST_DATABASE_PORT = '5433';

/**
 * The ONLY host/port/protocol tuple accepted for the RESTOCK test DB.
 *
 * Unlike the legacy `nest-practice-test` target, the RESTOCK target is a
 * strict, non-broadened tuple: no `localhost`, IPv6 loopback, remote host,
 * missing/other port, or `postgres:` protocol alias is accepted. A remote
 * host cannot prove the database is the dedicated disposable RESTOCK DB.
 */
const RESTOCK_TEST_PROTOCOL = 'postgresql:';
const RESTOCK_TEST_HOSTNAME = '127.0.0.1';
const RESTOCK_TEST_PORT = '5433';

/**
 * Resolve `rawUrl` into the normalized integration DATABASE_URL.
 *
 * @param rawUrl - the raw `process.env.DATABASE_URL` value.
 * @param contextLabel - non-secret caller label used in error messages
 *   (for example `[global-setup]`).
 * @returns the normalized URL string, safe to assign back to
 *   `process.env.DATABASE_URL`. The dedicated RESTOCK tuple is returned
 *   verbatim; the legacy target keeps its `localhost` rewrite.
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

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(`${contextLabel} DATABASE_URL must use PostgreSQL.`);
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

  // Dedicated RESTOCK suites require the exact loopback tuple: protocol
  // `postgresql:`, host `127.0.0.1`, port `5433`, and the RESTOCK database
  // name. This is intentionally NOT broadened to remote hosts, `localhost`,
  // IPv6, a missing/other port, or the `postgres:` alias — a remote target
  // cannot prove the database is the disposable RESTOCK DB. Credentials and
  // query parameters are preserved verbatim.
  if (databaseName === RESTOCK_DATABASE_NAME) {
    const matchesRestockTuple =
      parsed.protocol === RESTOCK_TEST_PROTOCOL &&
      parsed.hostname === RESTOCK_TEST_HOSTNAME &&
      parsed.port === RESTOCK_TEST_PORT;
    if (!matchesRestockTuple) {
      throw new Error(
        `${contextLabel} RESTOCK test DATABASE_URL must target the dedicated ` +
          `'${RESTOCK_DATABASE_NAME}' database at ` +
          `${RESTOCK_TEST_HOSTNAME}:${RESTOCK_TEST_PORT}.`,
      );
    }
    return parsed.toString();
  }

  // Every other target, including remote CI databases, must use the dedicated
  // test database name. On the developer's loopback interface, also require
  // the Compose test port (5433), never the dev port (5432). This is a
  // target-shape guard, not proof that a remote host is disposable.
  if (databaseName !== TEST_DATABASE_NAME) {
    throw new Error(
      `${contextLabel} DATABASE_URL must name the dedicated '${TEST_DATABASE_NAME}' test database.`,
    );
  }
  if (
    ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) &&
    parsed.port !== LOCAL_TEST_DATABASE_PORT
  ) {
    throw new Error(
      `${contextLabel} loopback test DATABASE_URL must use port ${LOCAL_TEST_DATABASE_PORT}.`,
    );
  }

  // Dual-stack fix: pin the ambiguous loopback hostname to IPv4.
  // Explicit hosts (IPv4, IPv6, remote/CI) are left untouched.
  if (parsed.hostname === 'localhost') {
    parsed.hostname = '127.0.0.1';
  }

  return parsed.toString();
}
