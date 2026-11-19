/**
 * editorial-live harness — fail-closed environment wiring (offline, light).
 *
 * The guard LOGIC is cash-live's (`../cash-live/disposable-env`,
 * `../cash-live/live-config`) — imported, never copied. This module only
 * supplies editorial-live's OWN frozen target and env names:
 *
 *   - opt-in flag `EDITORIAL_LIVE_DISPOSABLE=1`;
 *   - `DATABASE_URL` === `EDITORIAL_LIVE_DATABASE_URL`;
 *   - `postgresql://editorial_live:<pw>@127.0.0.1:<port>/editorial_live_test`,
 *     no query/fragment; ports 5432/5433 (always, cash-live rule) and 5434
 *     (editorial extra) are rejected;
 *   - `EDITORIAL_LIVE_FRONTEND_ORIGIN` (default http://127.0.0.1:4191),
 *     `EDITORIAL_LIVE_FIXTURE_PATH` (default .tmp/editorial-live/fixture.json),
 *     `EDITORIAL_LIVE_JWT_SECRET` (>= 32 chars, else generated in memory),
 *     `EDITORIAL_LIVE_ACCESS_TTL_SECONDS` (60..86400, default 7200).
 *
 * No Nest, no Prisma, no dotenv, no filesystem writes.
 */
import {
  checkDisposableDatabaseUrl,
  type DisposableDatabaseProfile,
  type GuardResult,
} from '../cash-live/disposable-env';
import {
  loadLiveHarnessConfig,
  type LiveHarnessConfig,
  type LiveHarnessConfigProfile,
} from '../cash-live/live-config';

export const EDITORIAL_LIVE_DB_USER = 'editorial_live';
export const EDITORIAL_LIVE_DB_NAME = 'editorial_live_test';
export const EDITORIAL_LIVE_DEFAULT_FIXTURE_PATH =
  '.tmp/editorial-live/fixture.json';
/** Frontend-agreed origin for this harness (single CORS entry). */
export const EDITORIAL_LIVE_DEFAULT_FRONTEND_ORIGIN = 'http://127.0.0.1:4191';

export const EDITORIAL_LIVE_DATABASE_PROFILE: DisposableDatabaseProfile =
  Object.freeze({
    flagName: 'EDITORIAL_LIVE_DISPOSABLE',
    urlEnvName: 'EDITORIAL_LIVE_DATABASE_URL',
    user: EDITORIAL_LIVE_DB_USER,
    database: EDITORIAL_LIVE_DB_NAME,
    // 5432/5433 are always rejected by the shared guard; 5434 is added here.
    additionalForbiddenPorts: Object.freeze(['5434']),
  });

export const EDITORIAL_LIVE_CONFIG_PROFILE: LiveHarnessConfigProfile =
  Object.freeze({
    envPrefix: 'EDITORIAL_LIVE',
    defaultFixturePath: EDITORIAL_LIVE_DEFAULT_FIXTURE_PATH,
    defaultFrontendOrigin: EDITORIAL_LIVE_DEFAULT_FRONTEND_ORIGIN,
  });

/** Disposable-database guard for the editorial target (shared logic). */
export function checkEditorialDisposableDatabase(
  env: NodeJS.ProcessEnv,
): GuardResult {
  return checkDisposableDatabaseUrl(
    {
      disposableFlag: env.EDITORIAL_LIVE_DISPOSABLE,
      databaseUrl: env.DATABASE_URL,
      cashLiveDatabaseUrl: env.EDITORIAL_LIVE_DATABASE_URL,
    },
    EDITORIAL_LIVE_DATABASE_PROFILE,
  );
}

/** Harness config (origin/fixture/secret/TTL) with EDITORIAL_LIVE_* names. */
export function loadEditorialLiveConfig(
  env: NodeJS.ProcessEnv,
): LiveHarnessConfig {
  return loadLiveHarnessConfig(env, EDITORIAL_LIVE_CONFIG_PROFILE);
}
