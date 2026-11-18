/**
 * cash-live harness — fail-closed, deterministic guards (offline, no DB).
 *
 * Pure functions only: no NestJS, no Prisma, no `dotenv`, no filesystem
 * writes. The live server (`server.ts`) refuses to boot unless EVERY guard
 * below passes, so an accidental run against a real database or an open
 * origin is impossible by construction.
 *
 * Credential discipline: error reasons describe the *components* of a URL
 * (user, host, port, database) but never echo the URL itself, so the
 * password can never leak into logs or test output.
 */
import * as path from 'node:path';

/** Username every disposable cash-live database connection must use. */
export const DISPOSABLE_DB_USER = 'cash_proof';

/** Database name every disposable cash-live connection must target. */
export const DISPOSABLE_DB_NAME = 'cash_closing_proof_test';

/** Shared dev/integration ports are ALWAYS forbidden for the live harness. */
export const FORBIDDEN_DB_PORTS: ReadonlySet<string> = new Set([
  '5432',
  '5433',
]);

/** The opt-in flag that proves the caller intends the disposable harness. */
export const DISPOSABLE_FLAG = 'CASH_LIVE_DISPOSABLE';
export const DISPOSABLE_FLAG_VALUE = '1';

/** Default fixture location, relative to the repository root. */
export const DEFAULT_FIXTURE_PATH = '.tmp/cash-live/fixture.json';

/** Default frontend origin (loopback, explicit port). */
export const DEFAULT_FRONTEND_ORIGIN = 'http://127.0.0.1:4189';

/**
 * Harness-specific disposable-database target. cash-live uses the default
 * profile below; sibling harnesses (e.g. test/editorial-live) pass their own
 * frozen profile. A profile can only ADD forbidden ports — 5432/5433
 * (`FORBIDDEN_DB_PORTS`) are always rejected for every profile.
 */
export interface DisposableDatabaseProfile {
  /** Opt-in env flag name that must be exactly "1". */
  flagName: string;
  /** Harness URL env name that must equal DATABASE_URL. */
  urlEnvName: string;
  /** Required database user. */
  user: string;
  /** Required database name. */
  database: string;
  /** Ports rejected IN ADDITION to `FORBIDDEN_DB_PORTS`. */
  additionalForbiddenPorts: readonly string[];
}

/** cash-live's own target (the default — behavior unchanged). */
export const CASH_LIVE_DATABASE_PROFILE: DisposableDatabaseProfile =
  Object.freeze({
    flagName: DISPOSABLE_FLAG,
    urlEnvName: 'CASH_LIVE_DATABASE_URL',
    user: DISPOSABLE_DB_USER,
    database: DISPOSABLE_DB_NAME,
    additionalForbiddenPorts: Object.freeze([]) as readonly string[],
  });

export interface DisposableDatabaseInput {
  disposableFlag?: string;
  databaseUrl?: string;
  /** The harness-specific URL (`profile.urlEnvName`; cash-live: CASH_LIVE_DATABASE_URL). */
  cashLiveDatabaseUrl?: string;
}

export interface GuardFailure {
  ok: false;
  reasons: string[];
}

export interface GuardSuccess {
  ok: true;
}

export type GuardResult = GuardSuccess | GuardFailure;

function failure(reasons: string[]): GuardFailure {
  return { ok: false, reasons };
}

/** Numeric, non-empty port that is not a shared dev/integration port. */
function checkDatabasePort(
  port: string,
  profile: DisposableDatabaseProfile,
  reasons: string[],
): void {
  if (!port || !/^\d+$/.test(port)) {
    reasons.push('DATABASE_URL must include an explicit numeric port');
  } else if (
    FORBIDDEN_DB_PORTS.has(port) ||
    profile.additionalForbiddenPorts.includes(port)
  ) {
    reasons.push(
      `DATABASE_URL port ${port} is forbidden (shared dev/integration port)`,
    );
  }
}

/** Scheme/host/user/database component checks against the fixed target. */
function checkDatabaseComponents(
  url: URL,
  profile: DisposableDatabaseProfile,
  reasons: string[],
): void {
  if (url.protocol !== 'postgresql:') {
    reasons.push(
      `DATABASE_URL protocol must be "postgresql:" (got "${url.protocol}")`,
    );
  }
  if (url.hostname !== '127.0.0.1') {
    reasons.push(
      `DATABASE_URL host must be "127.0.0.1" (got "${url.hostname}")`,
    );
  }
  if (decodeURIComponent(url.username) !== profile.user) {
    reasons.push(
      `DATABASE_URL user must be "${profile.user}" (got a different user)`,
    );
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (databaseName !== profile.database) {
    reasons.push(
      `DATABASE_URL database must be "${profile.database}" (got a different database)`,
    );
  }
  // Prisma reads connection options (host/socket/schema/ssl overrides) from
  // the URL query string — ANY query is rejected outright. Fragments are
  // equally meaningless and equally suspicious.
  if (url.search !== '') {
    reasons.push(
      'DATABASE_URL must not include query parameters (e.g. ?schema=, ?host=, ?sslmode=) — rejected',
    );
  }
  if (url.hash !== '') {
    reasons.push('DATABASE_URL must not include a URL fragment — rejected');
  }
}

/** Presence + equality of the two URL env vars; returns them when present. */
function checkUrlEnvPair(
  input: DisposableDatabaseInput,
  profile: DisposableDatabaseProfile,
  reasons: string[],
): string[] | null {
  const missing: string[] = [];
  if (!input.databaseUrl) missing.push('DATABASE_URL is unset');
  if (!input.cashLiveDatabaseUrl)
    missing.push(`${profile.urlEnvName} is unset`);
  if (missing.length > 0) {
    reasons.push(...missing);
    return null;
  }
  const databaseUrl = input.databaseUrl as string;
  const cashLiveUrl = input.cashLiveDatabaseUrl as string;
  if (databaseUrl !== cashLiveUrl) {
    reasons.push(
      `DATABASE_URL and ${profile.urlEnvName} must be the identical URL`,
    );
  }
  return [databaseUrl, cashLiveUrl];
}

/**
 * Validate the disposable database triple:
 *   - CASH_LIVE_DISPOSABLE must be exactly "1";
 *   - DATABASE_URL and CASH_LIVE_DATABASE_URL must both be set and equal;
 *   - the URL must be `postgresql://`, host `127.0.0.1`, user
 *     `cash_proof`, database `cash_closing_proof_test`;
 *   - the port must be present and must NOT be 5432/5433 (the shared dev
 *     and integration-test ports).
 * Another harness passes its own `profile` (flag/URL env names, user,
 * database, extra forbidden ports); 5432/5433 stay forbidden regardless.
 */
export function checkDisposableDatabaseUrl(
  input: DisposableDatabaseInput,
  profile: DisposableDatabaseProfile = CASH_LIVE_DATABASE_PROFILE,
): GuardResult {
  const reasons: string[] = [];

  if (input.disposableFlag !== DISPOSABLE_FLAG_VALUE) {
    reasons.push(
      `${profile.flagName} must be exactly "${DISPOSABLE_FLAG_VALUE}" (got ${
        input.disposableFlag === undefined ? 'unset' : 'a different value'
      })`,
    );
  }

  const urls = checkUrlEnvPair(input, profile, reasons);
  if (urls === null) return failure(reasons);

  let parsed: URL;
  try {
    parsed = new URL(urls[0]);
  } catch {
    reasons.push('DATABASE_URL is not a parseable URL');
    return failure(reasons);
  }

  checkDatabaseComponents(parsed, profile, reasons);
  checkDatabasePort(parsed.port, profile, reasons);

  return reasons.length === 0 ? { ok: true } : failure(reasons);
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]']);

/**
 * External-service credential keys that must NEVER be inherited by the
 * harness process. The harness is local-only; an inherited key for Resend,
 * AWS, or Inngest means the operator reused a real environment — refuse to
 * compile the module graph. Values are never echoed.
 */
export const DENIED_EXTERNAL_ENV_KEYS: readonly string[] = [
  'RESEND_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'INNGEST_EVENT_API_KEY',
  'INNGEST_SIGNING_KEY',
];

/**
 * Fail closed when any external-service credential is present in the run
 * environment. Checked BEFORE module compile in `server.ts`. Reasons name
 * the offending key only — never its value.
 */
export function checkDeniedExternalEnv(env: NodeJS.ProcessEnv): GuardResult {
  const reasons: string[] = [];
  for (const key of DENIED_EXTERNAL_ENV_KEYS) {
    if (env[key] !== undefined) {
      reasons.push(
        `${key} is set in the run environment — external service credentials must not be inherited; rerun with a minimal env (e.g. env -i)`,
      );
    }
  }
  return reasons.length === 0 ? { ok: true } : failure(reasons);
}

/**
 * Accept ONLY an explicit loopback HTTP(S) origin with a numeric port
 * (e.g. `http://127.0.0.1:4189`). Returns the normalized origin; throws
 * on anything else. This is the single CORS allowlist input for the
 * harness server.
 */
export function validateLoopbackHttpOrigin(
  raw: string,
  envName = 'CASH_LIVE_FRONTEND_ORIGIN',
): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${envName} is not a valid URL — rejected`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${envName} must use http: or https: — rejected`);
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `${envName} must be a loopback host (127.0.0.1 or [::1]) — rejected`,
    );
  }
  const port = parsed.port;
  if (
    !port ||
    !/^\d+$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535
  ) {
    throw new Error(
      `${envName} must include an explicit numeric port — rejected`,
    );
  }
  return parsed.origin;
}

/**
 * Resolve the fixture output path and refuse any traversal outside
 * `rootDir` (the repository root). Returns an absolute path guaranteed to
 * stay inside the repository.
 */
export function resolveFixturePathWithinRoot(
  rawPath: string | undefined,
  rootDir: string,
  options: { defaultPath: string; envName: string } = {
    defaultPath: DEFAULT_FIXTURE_PATH,
    envName: 'CASH_LIVE_FIXTURE_PATH',
  },
): string {
  const raw =
    rawPath && rawPath.trim().length > 0 ? rawPath.trim() : options.defaultPath;
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, raw);

  const relative = path.relative(root, resolved);
  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `${options.envName} must stay inside the repository root — rejected`,
    );
  }
  return resolved;
}
