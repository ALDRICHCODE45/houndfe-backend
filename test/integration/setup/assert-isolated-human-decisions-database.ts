/**
 * HD-EXP-JOURNEY isolated-DB target guard.
 *
 * The EXPIRATION journey truncates and reseeds a REAL PostgreSQL database, so
 * it must prove it targets the disposable isolated RESTOCK DB before every
 * reset. This module owns that proof.
 *
 * IMPORT SAFETY: importing this module reads nothing — no `.env.test` read, no
 * env mutation, no reset. All work happens inside the guard returned by
 * `createIsolatedDatabaseGuard`, so the module is safe to import offline (as the
 * unit suite does) and in any context. Jest `globalSetup` migrates BEFORE the
 * journey loads, so the in-suite precheck here is still required.
 *
 * Accepted target (exact tuple, redacted errors):
 *   postgresql://127.0.0.1:5433/nest-practice-restock-test
 * No `localhost`, IPv6, remote host, other port, other DB name, or `postgres:`
 * alias is accepted: a remote target cannot prove it is the disposable RESTOCK
 * DB. Credentials and query parameters are preserved verbatim and never echoed,
 * so a connection string cannot leak through an error message.
 */
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The exact protocol/host/port/database tuple the journey is allowed to reset. */
export const ISOLATED_HUMAN_DECISIONS_DATABASE = {
  protocol: 'postgresql:',
  hostname: '127.0.0.1',
  port: '5433',
  name: 'nest-practice-restock-test',
} as const;

/** Which of the two independent `DATABASE_URL` sources is being checked. */
export type DatabaseUrlSource = 'file' | 'active';

const SOURCE_LABELS: Record<DatabaseUrlSource, string> = {
  file: '.env.test',
  active: 'active process.env',
};

const GUARD_LABEL = '[hd-exp-journey]';

const DEFAULT_ENV_TEST_PATH = path.resolve(process.cwd(), '.env.test');

/**
 * Fail closed unless `rawUrl` is the exact isolated target. The error is generic
 * and never contains the URL, so credentials cannot leak into test output.
 */
export function assertMatchesIsolatedTarget(
  rawUrl: string | undefined,
  source: DatabaseUrlSource,
): void {
  const label = SOURCE_LABELS[source];
  if (!rawUrl) {
    throw new Error(
      `${GUARD_LABEL} refusing isolated-DB run: ${label} DATABASE_URL is unset.`,
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(
      `${GUARD_LABEL} refusing isolated-DB run: ${label} DATABASE_URL is not a valid URL.`,
    );
  }

  let databaseName = url.pathname.replace(/^\//, '');
  try {
    databaseName = decodeURIComponent(databaseName);
  } catch {
    // Keep the encoded segment when it cannot be decoded.
  }

  const matches =
    url.protocol === ISOLATED_HUMAN_DECISIONS_DATABASE.protocol &&
    url.hostname === ISOLATED_HUMAN_DECISIONS_DATABASE.hostname &&
    url.port === ISOLATED_HUMAN_DECISIONS_DATABASE.port &&
    databaseName === ISOLATED_HUMAN_DECISIONS_DATABASE.name;
  if (!matches) {
    throw new Error(
      `${GUARD_LABEL} refusing isolated-DB run: ${label} DATABASE_URL does not match the dedicated isolated RESTOCK target.`,
    );
  }
}

/** Injectable boundaries, so the guard is unit-testable offline. */
export interface IsolatedDatabaseGuardDeps {
  /** Raw `.env.test` text; default reads the file lazily when first needed. */
  readEnvTestFile?: () => string;
  /** ACTIVE URL used by Prisma/resets; default `process.env.DATABASE_URL`. */
  readActiveUrl?: () => string | undefined;
  /** Destructive baseline reset, run ONLY after both sources validate. */
  reset: () => Promise<void>;
  /** One-time success sink; default `console.log`. */
  log?: (message: string) => void;
}

/** A guard bound to one dependency set and one skip decision. */
export interface IsolatedDatabaseGuard {
  /** True when `SKIP_DB_INTEGRATION=1` or the ACTIVE URL is unset. */
  skip: boolean;
  /** Validate BOTH `.env.test` and the ACTIVE URL. */
  assertTarget: () => void;
  /** Validate the target, then run the injected reset. */
  resetBaseline: () => Promise<void>;
}

/**
 * Build the journey's isolated-DB guard. File reading and the reset are
 * injectable, so the guard can be exercised offline without touching disk or a
 * database. Nothing is read or reset until a returned method is invoked.
 */
export function createIsolatedDatabaseGuard(
  deps: IsolatedDatabaseGuardDeps,
): IsolatedDatabaseGuard {
  const readEnvTestFile =
    deps.readEnvTestFile ??
    (() => fs.readFileSync(DEFAULT_ENV_TEST_PATH, 'utf8'));
  const readActiveUrl = deps.readActiveUrl ?? (() => process.env.DATABASE_URL);
  const log = deps.log ?? ((message: string) => console.log(message));
  const skip = process.env.SKIP_DB_INTEGRATION === '1' || !readActiveUrl();

  let loggedOnce = false;

  const assertTarget = (): void => {
    const parsedEnv = dotenv.parse(readEnvTestFile());
    assertMatchesIsolatedTarget(parsedEnv.DATABASE_URL, 'file');
    assertMatchesIsolatedTarget(readActiveUrl(), 'active');

    if (!loggedOnce) {
      loggedOnce = true;
      log(
        `${GUARD_LABEL} isolated DB target OK: ${ISOLATED_HUMAN_DECISIONS_DATABASE.protocol}//${ISOLATED_HUMAN_DECISIONS_DATABASE.hostname}:${ISOLATED_HUMAN_DECISIONS_DATABASE.port}/${ISOLATED_HUMAN_DECISIONS_DATABASE.name}`,
      );
    }
  };

  const resetBaseline = async (): Promise<void> => {
    assertTarget();
    await deps.reset();
  };

  return { skip, assertTarget, resetBaseline };
}
